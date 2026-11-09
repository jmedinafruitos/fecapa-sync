// A deliberately strict RFC 5545 checker for the subset fecapa-sync writes.
// It throws on the first problem and returns the parsed calendar otherwise.

const encoder = new TextEncoder();
const TEXT_PROPS = new Set(['SUMMARY', 'LOCATION', 'DESCRIPTION', 'X-WR-CALNAME']);
const UTC_DATE_TIME = /^\d{8}T\d{6}Z$/;
const DATE = /^\d{8}$/;

function fail(message, line) {
  throw new Error(`invalid ICS: ${message}${line !== undefined ? ` (line ${line})` : ''}`);
}

/** Unescapes an RFC 5545 TEXT value; rejects unescaped `;` or `,` and unknown escapes. */
export function unescapeText(value, line) {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === ';' || char === ',') fail(`unescaped "${char}" in a TEXT value`, line);
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = value[++i];
    if (next === '\\' || next === ';' || next === ',') out += next;
    else if (next === 'n' || next === 'N') out += '\n';
    else fail(`bad escape "\\${next ?? ''}"`, line);
  }
  return out;
}

function checkDate(value, params, name, line) {
  if (params.VALUE === 'DATE') {
    if (!DATE.test(value)) fail(`${name} is not a DATE`, line);
  } else if (!UTC_DATE_TIME.test(value)) {
    fail(`${name} is not a UTC DATE-TIME`, line);
  }
  const [y, m, d] = [value.slice(0, 4), value.slice(4, 6), value.slice(6, 8)].map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) fail(`${name} is not a real date`, line);
}

export function validateIcs(text) {
  if (typeof text !== 'string' || !text.length) fail('empty');
  if (!text.endsWith('\r\n')) fail('does not end with CRLF');
  if (/\r(?!\n)|(?<!\r)\n/.test(text)) fail('line break that is not CRLF');
  const physical = text.slice(0, -2).split('\r\n');
  physical.forEach((line, i) => {
    if (encoder.encode(line).length > 75) fail(`line longer than 75 octets`, i + 1);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(line)) fail('control character', i + 1);
    if (i === 0 && line.startsWith(' ')) fail('starts with a continuation line', 1);
  });
  // Unfold.
  const lines = [];
  physical.forEach((line, i) => {
    if (line.startsWith(' ') || line.startsWith('\t')) lines[lines.length - 1].text += line.slice(1);
    else lines.push({ text: line, number: i + 1 });
  });

  const stack = [];
  let calendar = null;
  const events = [];
  for (const { text: line, number } of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) fail('content line without "name:value"', number);
    const [name, ...rawParams] = line.slice(0, colon).split(';');
    const value = line.slice(colon + 1);
    if (!/^[A-Z][A-Z0-9-]*$/.test(name)) fail(`bad property name "${name}"`, number);
    const params = {};
    for (const param of rawParams) {
      const match = /^([A-Z-]+)=([^";:,]+)$/.exec(param);
      if (!match) fail(`bad parameter "${param}"`, number);
      params[match[1]] = match[2];
    }
    if (name === 'BEGIN') {
      if (value === 'VCALENDAR') {
        if (stack.length || calendar) fail('VCALENDAR must be the only top-level component', number);
        calendar = { props: {}, events };
        stack.push({ type: 'VCALENDAR', props: calendar.props });
      } else if (value === 'VEVENT') {
        if (stack.at(-1)?.type !== 'VCALENDAR') fail('VEVENT outside VCALENDAR', number);
        const event = { props: {}, line: number };
        events.push(event);
        stack.push({ type: 'VEVENT', props: event.props });
      } else fail(`unexpected component ${value}`, number);
      continue;
    }
    if (name === 'END') {
      const open = stack.pop();
      if (!open || open.type !== value) fail(`END:${value} does not close ${open?.type}`, number);
      continue;
    }
    const current = stack.at(-1);
    if (!current) fail('property outside a component', number);
    if (current.props[name]) fail(`${name} appears twice`, number);
    current.props[name] = { value: TEXT_PROPS.has(name) ? unescapeText(value, number) : value, params, line: number };
  }
  if (stack.length) fail(`${stack.at(-1).type} is not closed`);
  if (!calendar) fail('no VCALENDAR');
  if (lines[0].text !== 'BEGIN:VCALENDAR' || lines.at(-1).text !== 'END:VCALENDAR') fail('must start and end with the VCALENDAR');
  if (calendar.props.VERSION?.value !== '2.0') fail('VERSION:2.0 missing');
  if (!calendar.props.PRODID?.value) fail('PRODID missing');

  const uids = new Set();
  for (const event of events) {
    const p = event.props;
    for (const required of ['UID', 'DTSTAMP', 'DTSTART']) if (!p[required]) fail(`VEVENT without ${required}`, event.line);
    if (uids.has(p.UID.value)) fail(`duplicate UID ${p.UID.value}`, event.line);
    uids.add(p.UID.value);
    checkDate(p.DTSTAMP.value, p.DTSTAMP.params, 'DTSTAMP', p.DTSTAMP.line);
    if (p.DTSTAMP.params.VALUE) fail('DTSTAMP must be a DATE-TIME', p.DTSTAMP.line);
    checkDate(p.DTSTART.value, p.DTSTART.params, 'DTSTART', p.DTSTART.line);
    if (p.DTEND) {
      checkDate(p.DTEND.value, p.DTEND.params, 'DTEND', p.DTEND.line);
      if ((p.DTEND.params.VALUE ?? 'DATE-TIME') !== (p.DTSTART.params.VALUE ?? 'DATE-TIME')) fail('DTEND and DTSTART differ in type', p.DTEND.line);
      if (p.DTEND.value <= p.DTSTART.value) fail('DTEND is not after DTSTART', p.DTEND.line);
    }
    if (p.SEQUENCE && !/^\d+$/.test(p.SEQUENCE.value)) fail('SEQUENCE is not a non-negative integer', p.SEQUENCE.line);
    if (p.STATUS && !['TENTATIVE', 'CONFIRMED', 'CANCELLED'].includes(p.STATUS.value)) fail(`bad STATUS ${p.STATUS.value}`, p.STATUS.line);
    if (p['LAST-MODIFIED']) checkDate(p['LAST-MODIFIED'].value, {}, 'LAST-MODIFIED', p['LAST-MODIFIED'].line);
  }
  return calendar;
}
