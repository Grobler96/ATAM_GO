// n8n WF6 (PuIT1ap0n839C7FD), node "Build Contact Body" (webhook create-xero-customer). Copy kept in the repo.
// 16 Nov 2026 (v89): also saves the delivery address on the new Xero contact (Xero "street" address).
// The site sends the order's delivery address as one text line, for example
//   "AWR, 10 windmill avenue, Manchester, Lancashire, M5 3nf, GB"  (lines inside can be split by new lines or commas).
// When the line ends with a 2 letter country and a UK style postcode, it is split into Xero's fields; otherwise the whole text
// is kept as address lines so nothing is lost. A bad or missing address never stops the customer being created.
const hook = $('Create Xero Customer (webhook)').first().json;
const b = hook.body || {};
const name = String(b.name || '').trim().slice(0, 255);
const email = String(b.email || '').trim().slice(0, 255);
if (name.length < 3) return [{ json: { invalid: true, error: 'A customer name of at least 3 letters is needed.' } }];
const body = { Name: name };
if (email) body.EmailAddress = email;

function buildAddress(text) {
  const parts = String(text || '').split(/[\n\r,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (!parts.length) return null;
  const addr = { AddressType: 'STREET' };
  const ukPost = /^[A-Za-z]{1,2}[0-9][A-Za-z0-9]?\s*[0-9][A-Za-z]{2}$/;
  let rest = parts.slice();
  let country = null;
  if (rest.length > 1 && /^[A-Za-z]{2}$/.test(rest[rest.length - 1])) country = rest.pop().toUpperCase();
  if (rest.length > 1 && ukPost.test(rest[rest.length - 1])) {
    addr.PostalCode = rest.pop().toUpperCase().replace(/^(.+?)\s*([0-9][A-Z]{2})$/, '$1 $2');
    if (country) addr.Country = country === 'GB' ? 'United Kingdom' : country;
    // Xero fields: region (county) and city come from the end, the rest are the address lines.
    if (rest.length > 3) addr.Region = rest.pop();
    if (rest.length > 2) addr.City = rest.pop();
    else if (rest.length === 2) addr.City = rest.pop();
  } else {
    // Unknown layout: keep everything as lines.
    rest = parts.slice();
  }
  if (rest.length > 4) rest = rest.slice(0, 3).concat([rest.slice(3).join(', ')]);
  rest.forEach(function (line, i) { addr['AddressLine' + (i + 1)] = line.slice(0, 500); });
  return addr;
}
try {
  const a = buildAddress(b.address);
  if (a && (a.AddressLine1 || a.PostalCode)) body.Addresses = [a];
} catch (e) { /* ignore: the customer is still created without an address */ }
return [{ json: { invalid: false, body: body } }];
