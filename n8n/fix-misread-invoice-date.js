// MISREAD INVOICE DATE (19 Nov 2026, v94, Steph: SI2577740 for PO 876997). 16/11/26 was read as year 16, month 11, day 26 = 2016-11-26.
// The Parse Extraction step already swaps a year-first date back to day/month/year, but only when the year is before 2015, so 2016 to 2023 slipped through.
// Here the same swap is done for 2015 to 2023, and only when the swapped date is a real date within 60 days before to 14 days after today (as in the Parse node).
// The invoice stays at low confidence (that rule is untouched), so a person still confirms the date. Never throws.
const item = $input.first().json;
try {
  if (item._route !== 'pending' || !item.extracted_invoice_date) return [{ json: item }];
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(String(item.extracted_invoice_date));
  if (!m) return [{ json: item }];
  const yr = Number(m[1]);
  if (yr < 2015 || yr >= 2024) return [{ json: item }];
  const fy = 2000 + Number(m[3]), fm = m[2], fd = String(m[1]).slice(2);
  const fixedStr = fy + '-' + fm + '-' + fd;
  const fixed = new Date(fixedStr + 'T00:00:00Z');
  if (isNaN(fixed.getTime()) || fixed.toISOString().slice(0, 10) !== fixedStr) return [{ json: item }];
  const fdiff = (Date.now() - fixed.getTime()) / (1000 * 60 * 60 * 24);
  if (fdiff > 60 || fdiff < -14) return [{ json: item }];
  const out = Object.assign({}, item);
  out.extracted_invoice_date = fixedStr;
  let n = String(item.extraction_notes || '');
  const a = n.indexOf('⚠ Extracted invoice date ('), tag = 'flagged low confidence as a result.', b = n.indexOf(tag, a);
  if (a >= 0 && b > a) n = (n.slice(0, a) + n.slice(b + tag.length)).trim();
  out.extraction_notes = ['⚠ The invoice date was read as ' + item.extracted_invoice_date + ' (year-first); it has been corrected to ' + fixedStr + ' (day/month/year) - please check it.', n].filter(Boolean).join(' ');
  return [{ json: out }];
} catch (e) { return [{ json: item }]; }
