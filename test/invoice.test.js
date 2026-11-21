const assert = require('node:assert/strict');
const { test } = require('node:test');
const invoice = require('../lib/invoice');
const orders = require('../lib/orders');
const pricing = require('../lib/pricing');
const reports = require('../lib/reports');

function recordOrder(items, coupon = '') {
  const db = { nextOrderId: 1001, orders: [] };
  const { subtotal, discount, tax, total } = pricing.computeTotals(items, coupon);
  const order = orders.add(db, {
    date: '2021-11-25', items, coupon, subtotal, discount, tax, total
  });
  return { db, order };
}

const itemsWithExplicitRates = [
  { name: 'Rice', hsn: '1006', price: 100, qty: 2, gstRate: 5 },
  { name: 'Ghee', hsn: '0405', price: 400, qty: 1, gstRate: 12 }
];

test('a mixed-HSN checkout with SAVE10 prints the billed total and GST', () => {
  const { order } = recordOrder([
    { name: 'Rice', hsn: '1006', price: 640, qty: 1 },
    { name: 'Ghee', hsn: '0405', price: 260, qty: 1 }
  ], 'SAVE10');

  assert.equal(order.total, 866.88);
  assert.equal(order.tax, 56.88);
  const { rows, ...figures } = invoice.computeInvoiceFigures(order);
  assert.deepEqual(figures, {
    subtotal: 900, discount: 90, tax: 56.88, cgst: 28.44, sgst: 28.44, total: 866.88
  });
  assert.deepEqual(rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [
    [5, 28.8],
    [12, 28.08]
  ]);

  const html = invoice.render(order);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹56\.88<\/td>/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹866\.88<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('an explicit whole-percent rate without a coupon produces a matching invoice', () => {
  const { order } = recordOrder([
    { name: 'Rice', sku: 'RICE', hsn: '1006', price: 5.1, qty: 2, gstRate: 5 }
  ]);

  assert.equal(order.tax, 0.51);
  assert.equal(order.total, 10.71);
  assert.deepEqual(invoice.computeInvoiceFigures(order), {
    subtotal: 10.2, discount: 0, tax: 0.51, cgst: 0.26, sgst: 0.25, total: 10.71,
    rows: [
      {
        name: 'Rice', sku: 'RICE', hsn: '1006', qty: 2, price: 5.1,
        gstPercent: 5, line: 10.2, lineTax: 0.51
      }
    ]
  });
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('the invoice resolves each HSN-only line to its checkout GST rate', () => {
  // New orders store the HSN and omit gstRate from each line.
  const { order } = recordOrder([
    { name: 'Rice', hsn: '1006', price: 100, qty: 2 },
    { name: 'Ghee', hsn: '0405', price: 300, qty: 1 },
    { name: 'Tea', hsn: '0902', price: 100, qty: 1 }
  ]);

  assert.equal(order.tax, 64);
  assert.equal(order.total, 664);
  const { rows, ...figures } = invoice.computeInvoiceFigures(order);
  assert.deepEqual(figures, {
    subtotal: 600, discount: 0, tax: 64, cgst: 32, sgst: 32, total: 664
  });
  assert.deepEqual(rows.map(({ hsn, gstPercent, lineTax }) => [hsn, gstPercent, lineTax]), [
    ['1006', 5, 10],
    ['0405', 12, 36],
    ['0902', 18, 18]
  ]);

  const html = invoice.render(order);
  assert.match(html, /<td>1006<\/td><td class="r">2<\/td><td class="r">₹100\.00<\/td><td class="r">5%<\/td><td class="r">₹10\.00<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('a percentage coupon produces the same GST and total in the invoice and reconciliation report', () => {
  const { db, order } = recordOrder(itemsWithExplicitRates, 'SAVE10');

  assert.equal(order.discount, 60);
  assert.equal(order.tax, 52.2);
  assert.equal(order.total, 592.2);
  const { rows, ...figures } = invoice.computeInvoiceFigures(order);
  assert.deepEqual(figures, {
    subtotal: 600, discount: 60, tax: 52.2, cgst: 26.1, sgst: 26.1, total: 592.2
  });
  assert.deepEqual(rows.map(({ lineTax }) => lineTax), [9, 43.2]);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);

  assert.deepEqual(reports.getGstReconciliation(db), {
    totalChecked: 1,
    mismatchCount: 0,
    totalDelta: 0,
    rows: [{
      orderId: 1001, date: '2021-11-25', customer: 'Walk-in', coupon: 'SAVE10',
      ledgerSubtotal: 600, ledgerDiscount: 60, ledgerTax: 52.2, ledgerTotal: 592.2,
      invoiceDiscount: 60, invoiceTax: 52.2, invoiceTotal: 592.2, delta: 0, matched: true
    }]
  });
});

test('the invoice apportions a flat coupon before calculating GST', () => {
  const { order } = recordOrder(itemsWithExplicitRates, 'FLAT50');

  assert.equal(order.discount, 50);
  assert.equal(order.tax, 53.17);
  assert.equal(order.total, 603.17);
  const { rows, ...figures } = invoice.computeInvoiceFigures(order);
  assert.deepEqual(figures, {
    subtotal: 600, discount: 50, tax: 53.17, cgst: 26.59, sgst: 26.58, total: 603.17
  });
  assert.deepEqual(rows.map(({ lineTax }) => lineTax), [9.17, 44]);
});

test('the invoice respects the percentage coupon cap', () => {
  const { order } = recordOrder([
    { name: 'Tea', price: 2000, qty: 1, gstRate: 18 }
  ], 'SAVE10');

  assert.equal(order.discount, 150);
  assert.equal(order.tax, 333);
  assert.equal(order.total, 2183);
  const { rows, ...figures } = invoice.computeInvoiceFigures(order);
  assert.deepEqual(figures, {
    subtotal: 2000, discount: 150, tax: 333, cgst: 166.5, sgst: 166.5, total: 2183
  });
  assert.deepEqual(rows.map(({ lineTax }) => lineTax), [333]);
});

test('the invoice ignores below-minimum and inactive coupons on stored orders with no discount', () => {
  const belowMinimum = {
    items: [{ name: 'Tea', price: 100, qty: 1, gstRate: 18 }],
    coupon: 'FLAT50', subtotal: 100, discount: 0, tax: 18, total: 118
  };
  const inactive = {
    items: [{ name: 'Tea', price: 1000, qty: 1, gstRate: 18 }],
    coupon: 'DIWALI20', subtotal: 1000, discount: 0, tax: 180, total: 1180
  };

  const belowMinimumInvoice = invoice.computeInvoiceFigures(belowMinimum);
  assert.equal(belowMinimumInvoice.discount, 0);
  assert.equal(belowMinimumInvoice.total, 118);

  const inactiveInvoice = invoice.computeInvoiceFigures(inactive);
  assert.equal(inactiveInvoice.discount, 0);
  assert.equal(inactiveInvoice.total, 1180);
});

test('the invoice honors the recorded discount after a coupon is deactivated', () => {
  const order = {
    items: [{ name: 'Tea', price: 1000, qty: 1, gstRate: 18 }],
    coupon: 'DIWALI20', subtotal: 1000, discount: 200, tax: 144, total: 944
  };

  const { rows, ...figures } = invoice.computeInvoiceFigures(order);
  assert.deepEqual(figures, {
    subtotal: 1000, discount: 200, tax: 144, cgst: 72, sgst: 72, total: 944
  });
  assert.equal(rows[0].lineTax, 144);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('the invoice preserves a recorded zero discount and looks up coupons for orders without a discount field', () => {
  const order = {
    items: [{ name: 'Tea', price: 100, qty: 1, gstRate: 18 }],
    coupon: 'WELCOME'
  };

  assert.equal(invoice.computeInvoiceFigures({ ...order, discount: 0 }).total, 118);
  assert.equal(invoice.computeInvoiceFigures(order).total, 112.1);
});

test('the invoice honors decimal and zero GST rates', () => {
  const { order } = recordOrder([
    { name: 'Rice', hsn: '1006', price: 100, qty: 1, gstRate: 0.05 },
    { name: 'Zero-rated item', hsn: '1006', price: 100, qty: 1, gstRate: 0 }
  ]);

  assert.equal(order.tax, 5);
  assert.equal(order.total, 205);
  const { rows, ...figures } = invoice.computeInvoiceFigures(order);
  assert.deepEqual(figures, {
    subtotal: 200, discount: 0, tax: 5, cgst: 2.5, sgst: 2.5, total: 205
  });
  assert.deepEqual(rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [
    [5, 5],
    [0, 0]
  ]);
});

test('the invoice sums rounded line taxes as checkout does', () => {
  const { order } = recordOrder([
    { name: 'Line A', price: 0.1, qty: 1, gstRate: 5 },
    { name: 'Line B', price: 0.1, qty: 1, gstRate: 5 }
  ]);

  assert.equal(order.tax, 0.02);
  assert.equal(order.total, 0.22);
  const { rows, ...figures } = invoice.computeInvoiceFigures(order);
  assert.deepEqual(figures, {
    subtotal: 0.2, discount: 0, tax: 0.02, cgst: 0.01, sgst: 0.01, total: 0.22
  });
  assert.deepEqual(rows.map(({ lineTax }) => lineTax), [0.01, 0.01]);
});

test('the invoice still warns when its total differs from the recorded total', () => {
  const { order } = recordOrder([{ name: 'Rice', hsn: '1006', price: 100, qty: 1 }]);
  order.total = 106;

  assert.match(invoice.render(order), /Invoice computed total \(₹105\.00\) differs from Order Ledger recorded total \(₹106\.00\) by -₹1\.00\./);
});
