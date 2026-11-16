// TerraCorridor exports. The platform hands work to the systems operators already run; it does not
// replace them. CSV for a maintenance system (Maximo, SAP), GeoJSON for Esri, PDF for a person.
// No write-back integrations: a file a coordinator imports is the whole interface.
(function (root) {
  const cell = (v) => { const s = v == null ? '' : Array.isArray(v) ? v.join('; ') : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = (rows, cols) => [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';

  const WO_COLUMNS = ['work_order_id', 'segment', 'km_from', 'km_to', 'module', 'kind', 'priority', 'due_by', 'reason', 'status', 'approved_by', 'approved_at', 'earliest_start', 'obligation_status', 'obligation_steps', 'lat', 'lon'];
  function workOrdersCsv(orders) {
    return csv((orders || []).map((w) => ({ work_order_id: w.id, segment: w.segment, km_from: w.kmFrom, km_to: w.kmTo, module: w.module, kind: w.kind, priority: w.priority, due_by: w.dueBy, reason: w.reason,
      status: w.status, approved_by: w.approvedBy, approved_at: w.approvedAt, earliest_start: w.check && w.check.earliestStart, obligation_status: w.check && w.check.status,
      obligation_steps: w.check ? w.check.steps.map((s) => `${s.id}: ${s.do}`) : [], lat: w.lat, lon: w.lon })), WO_COLUMNS);
  }

  // One line feature per kilometre with the joined record flattened into properties, for ArcGIS or QGIS.
  function segmentsGeoJSON(records, segments) {
    const line = Object.fromEntries((segments || []).map((s) => [s.id, s.centreline]));
    return { type: 'FeatureCollection', features: (records || []).filter((r) => line[r.id]).map((r) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: line[r.id] },
      properties: { segment: r.id, km_from: r.kmFrom, km_to: r.kmTo,
        class_now: r.classLocation ? r.classLocation.class.now : null, class_committed: r.classLocation ? r.classLocation.class.committed : null, class_status: r.classLocation ? r.classLocation.status : 'unverified',
        class_change_date: r.classLocation && r.classLocation.change ? r.classLocation.change.date : null, plan_due: r.classLocation && r.classLocation.clock ? r.classLocation.clock.due : null,
        dwellings_existing: r.classLocation ? r.classLocation.units.existing : null, dwellings_committed: r.classLocation ? r.classLocation.units.committed : null,
        geohazard_tier: r.geohazard ? r.geohazard.tier : 'unverified', geohazard_score: r.geohazard ? r.geohazard.score : null, geohazard: r.geohazard ? r.geohazard.hazard : null,
        obligations: (r.obligations || []).length, encroachment_flags: (r.encroachment || []).length, open_items: (r.openItems || []).length } })) };
  }

  // A small PDF writer: text only, Helvetica, letter pages. Enough for a work order, a draft filing or an evidence pack.
  const clean = (s) => String(s == null ? '' : s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/→/g, '->').replace(/[^\x20-\x7e]/g, '?');
  function wrap(text, width) {
    const out = [];
    for (const para of String(text == null ? '' : text).split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        if ((line + ' ' + word).trim().length > width) { if (line) out.push(line); line = word; while (line.length > width) { out.push(line.slice(0, width)); line = line.slice(width); } }
        else line = (line + ' ' + word).trim();
      }
      out.push(line);
    }
    return out;
  }
  function pdf(title, lines) {
    const body = lines.flatMap((l) => (typeof l === 'string' ? wrap(clean(l), 92).map((t) => ({ t })) : wrap(clean(l.text), l.h ? 70 : 92).map((t) => ({ t, h: l.h }))));
    const pages = []; for (let i = 0; i < body.length; i += 54) pages.push(body.slice(i, i + 54));
    if (!pages.length) pages.push([]);
    const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    const objs = [];
    const add = (s) => { objs.push(s); return objs.length; };
    add('<< /Type /Catalog /Pages 2 0 R >>'); add('');   // pages placeholder
    const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'), bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
    const kids = [];
    pages.forEach((pg, n) => {
      let s = `BT /F2 15 Tf 54 750 Td (${esc(clean(title))}) Tj ET\nBT /F1 8 Tf 54 734 Td (Page ${n + 1} of ${pages.length}) Tj ET\n`;
      let y = 712;
      for (const l of pg) { s += `BT /${l.h ? 'F2' : 'F1'} ${l.h ? 11 : 9.5} Tf 54 ${y} Td (${esc(l.t)}) Tj ET\n`; y -= 12.6; }
      const content = add(`<< /Length ${s.length} >>\nstream\n${s}endstream`);
      kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R >>`));
    });
    objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
    let out = '%PDF-1.4\n'; const offsets = [];
    objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
    return out + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  }

  const money = (n) => (n == null ? 'not priced' : '$' + Math.round(n).toLocaleString('en-US'));

  // A draft of the plan an operator files when a class changes. A draft only: it lists what the record
  // supports and leaves a marked blank for everything it does not know.
  function draftFilingLines(record, comparison, chosenKey) {
    const c = record.classLocation, ca = c.jurisdiction !== 'US', chosen = comparison && comparison.paths.find((p) => p.key === chosenKey);
    const L = [];
    L.push({ text: 'DRAFT - NOT A FILING. For review and completion by a qualified engineer.', h: true });
    L.push(ca ? 'Prepared in the shape of a proposed plan under section 42 of the Onshore Pipeline Regulations (CER Filing Manual, Guide E).' : 'Prepared for a class location change under 49 CFR 192.611.');
    L.push('', { text: '1. Segment', h: true }, `Segment ${record.id}, km ${record.kmFrom} to ${record.kmTo}. Assessment window km ${c.window.kmFrom} to ${c.window.kmTo}.`, 'Pipeline, licence and operator: [operator to complete]');
    L.push('', { text: '2. Change in class location', h: true });
    L.push(c.change ? `From Class ${c.change.from} to Class ${c.change.to}. ${c.change.date ? 'Date of change: ' + c.change.date + ' (' + c.change.basis + ').' : 'Date not yet established (' + c.change.basis + ').'}` : 'No change identified.');
    if (c.clock) L.push(`Deadline: ${c.clock.due}. ${c.clock.basis}`);
    L.push('', { text: '3. Evidence', h: true }, `Dwelling units in the window: ${c.units.existing} existing, ${c.units.committed} with building permits issued, ${c.units.possible} with development permits only.`, `Basis: ${c.basis}.`);
    for (const e of c.evidence) L.push(`- ${e.kind.replace(/_/g, ' ')} ${e.id}, ${e.issued}, ${e.units} units, near km ${e.km}${e.note ? ' (' + e.note + ')' : ''}`);
    for (const p of c.plans) L.push(`- Plan in effect: ${p.name} (${p.type}, bylaw ${p.bylaw})`);
    if (c.fieldCounted) L.push('The existing count was made on site and replaces the estimate.'); else L.push('The existing count is an estimate and has not been confirmed on site.');
    L.push('', { text: '4. Options considered', h: true });
    for (const p of (comparison ? comparison.paths : [])) L.push(`- ${p.label}: ${p.eligible ? money(p.total) + ' over ' + comparison.horizonYears + ' years, about ' + p.months + ' months' + (p.meetsDeadline === false ? ', MISSES the deadline' : '') : 'not available. ' + p.why}`);
    if (comparison && comparison.pricedWithPlaceholders) L.push('Costs above use placeholder assumptions, not operator figures. [operator to replace]');
    L.push('', { text: '5. Proposed path', h: true }, chosen ? `${chosen.label}. Expected completion ${chosen.finishBy}.` : '[engineer to select]');
    if (chosen) for (const x of chosen.conditions) L.push('- ' + x);
    if (chosen && chosen.materials && chosen.materials.note) L.push('- ' + chosen.materials.note);
    L.push('', { text: '6. Interim measures', h: true }, '[operator to complete]');
    if (record.geohazard && ['amber', 'red', 'red-uncertain'].includes(record.geohazard.tier)) L.push('', { text: '7. Other conditions on this kilometre', h: true }, `Geohazard: ${record.geohazard.tier}, ${record.geohazard.hazard || 'ground failure'}. ${record.geohazard.why || ''}`);
    if ((record.obligations || []).length) L.push(`Land obligations on file: ${record.obligations.map((o) => o.id).join(', ')}.`);
    L.push('', { text: 'Still needed from the operator', h: true });
    for (const u of (comparison ? comparison.unknowns : [])) L.push('- ' + u);
    return L;
  }

  function evidenceLines(pack) {
    const L = [{ text: `Segment ${pack.segment}, km ${pack.km[0]} to ${pack.km[1]}`, h: true }, `Generated ${pack.generatedAt}`, `Record SHA-256: ${pack.recordHash}`, `Decision chain: ${pack.chain.ok ? 'intact' : 'BROKEN at entry ' + pack.chain.brokenAt}, ${pack.chain.entries} entries, head ${pack.chain.head || '-'}`, '', { text: 'Sources', h: true }];
    for (const s of pack.sources) L.push(`- ${s.name}${s.dataset ? ' (' + s.dataset + ')' : ''}${s.fetchedAt ? ', fetched ' + s.fetchedAt : ''}`, `  ${s.url || ''}`, `  sha256 ${s.sha256 || 'not hashed'}`);
    L.push('', { text: 'Decisions and findings', h: true });
    if (!pack.decisions.length) L.push('None recorded for this kilometre.');
    for (const d of pack.decisions) L.push(`${d.seq}. ${d.at.slice(0, 16).replace('T', ' ')}  ${d.what}  by ${d.by}${d.estimate != null ? '  estimate ' + money(d.estimate) : ''}${d.value != null ? '  value ' + d.value : ''}`, ...(d.reason ? [`   ${d.reason}`] : []), `   ${d.hash}`);
    return L;
  }

  const api = { csv, WO_COLUMNS, workOrdersCsv, segmentsGeoJSON, pdf, wrap, draftFilingLines, evidenceLines, money };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TC_EXPORT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
