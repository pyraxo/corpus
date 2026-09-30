// Bookmark cards for the library: wall tiles, grid cards, list rows.
import { esc, num } from '../core/dom.js';
import { formatOf, isDoc, label, minutes, progressOf, readTime, triage } from '../data/library.js';
import { daysLeft } from '../data/query.js';
import { hlMark } from '../features/highlights.js';
import { byline, formatBadge, host, mediaTile, plain, progressMark, readMark, relDate, snippet, tagPills, visual } from './format.js';

export function listItem(r) {
  const v = visual(r);
  return `<article class="row" data-open="${r.id}" tabindex="0">
    <div class="row-main">${byline(r)}<h3>${esc(r.title || snippet(r, 90))}</h3><p class="row-snippet">${esc(snippet(r, 240, { afterTitle: true }))}</p>
    <div class="meta">${formatBadge(r)}${daysLeft(r) != null ? `<span class="pill trash-pill">${daysLeft(r)}d left</span>` : ''}${tagPills(r)}${triage(r) ? `<span class="state">${triage(r)}</span>` : ''}${readMark(r)}${progressMark(r)}${hlMark(r)}</div></div>
    ${v ? `<div class="row-thumb"><img src="${esc(v.url)}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>` : ''}
  </article>`;
}
export function gridItem(r) {
  const v = visual(r);
  return `<article class="card" data-open="${r.id}" tabindex="0">
    ${v ? mediaTile({ ...v, w: 16, h: 10 }, 'fixed') : `<div class="card-type">${esc(snippet(r, 160))}</div>`}
    <div class="card-body">${byline(r)}<h3>${esc(r.title || snippet(r, 90))}</h3>${v ? `<p class="card-snippet">${esc(snippet(r, 140, { afterTitle: true }))}</p>` : ''}
    <div class="meta">${formatBadge(r)}${tagPills(r)}${readMark(r)}${progressMark(r)}${hlMark(r)}</div></div>
  </article>`;
}
// Wall tiles vary by content so the columns read like a laid brick wall.
export function wallItem(r) {
  const v = visual(r);
  const f = formatOf(r);
  const text = plain(r.text);
  let body;
  if (isDoc(r)) {
    // Books and documents: the cover, then title and author, like a spine you can pick up.
    const d = r.doc;
    const kick = [label(f), d.pages ? `${num.format(d.pages)} pages` : '', readTime(minutes(r))].filter(Boolean).join(' · ');
    body = `${v ? `<div class="tile-cover"><img src="${esc(v.url)}" alt="" loading="lazy"></div>` : ''}<div class="tile-pad doc-tile"><span class="kicker">${esc(kick)}</span><h3 class="serif">${esc(r.title)}</h3>${d.authors?.length ? `<p class="doc-by">${esc(d.authors.join(', '))}</p>` : ''}${!v && (d.description || d.excerpt) ? `<p>${esc(snippet({ text: d.description || d.excerpt }, 220))}</p>` : ''}${progressOf(r) > 0.005 ? `<span class="tile-progress"><i style="--p:${progressOf(r)}"></i></span>` : ''}</div>`;
  } else if (f === 'format:article' && !r.article) body = `<div class="tile-pad"><span class="kicker">Article</span><p class="lead">${esc(text || 'Long-form post on X')}</p><p class="muted small">Not captured yet — open to capture it now.</p></div>`;
  else if (f === 'format:article' && r.article) body = `${v ? mediaTile(v) : ''}<div class="tile-pad"><span class="kicker">Article</span><h3 class="serif">${esc(r.article.title)}</h3><p>${esc(snippet(r, 200))}</p></div>`;
  else if (f === 'format:thread' && r.thread) body = `<div class="tile-pad"><span class="kicker">Thread · ${r.thread.length}</span><p class="lead">${esc(text.length > 300 ? `${text.slice(0, 300).replace(/\s+\S*$/, '')}…` : text)}</p><ol class="thread-peek">${r.thread.slice(r.focalIndex + 1, r.focalIndex + 3).map(t => `<li>${esc(plain(t.text).slice(0, 110))}${plain(t.text).length > 110 ? '…' : ''}</li>`).join('')}</ol></div>${v ? mediaTile(v) : ''}`;
  else if (!v && text.length && text.length <= 180 && f !== 'format:link' && f !== 'format:repo') body = `<div class="tile-pad quote"><p class="serif big">${esc(text)}</p></div>`;
  else if ((f === 'format:link' || f === 'format:repo') && r.card) body = `${text ? `<div class="tile-pad"><p>${esc(snippet(r, 220))}</p></div>` : ''}<div class="linkcard">${r.card.image ? mediaTile({ url: r.card.image, w: 1.91, h: 1 }) : ''}<div class="linkcard-text"><span class="domain">${esc(r.card.domain || host(r.card.url))}</span><strong>${esc(r.card.title || '')}</strong></div></div>`;
  else body = `${v ? mediaTile(v) : ''}${text ? `<div class="tile-pad"><p>${esc(text.length > 420 ? `${text.slice(0, 420).replace(/\s+\S*$/, '')}…` : text)}</p></div>` : ''}`;
  const left = daysLeft(r);
  const pills = (left != null ? `<span class="pill trash-pill">${left}d left</span>` : '') + tagPills(r);
  return `<article class="tile" data-open="${r.id}" tabindex="0">${body}${pills ? `<div class="tile-tags">${pills}</div>` : ''}<footer class="tile-foot">${byline(r, false)}${readMark(r)}${progressMark(r)}${hlMark(r)}<span class="date">${relDate(r.postedAt)}</span></footer></article>`;
}
export function estimateHeight(r, colWidth) {
  const v = visual(r); const f = formatOf(r); const t = plain(r.text).length;
  let h = 86;
  if (isDoc(r)) return h + (v ? 300 : 120) + 70;
  if (v) h += colWidth * (v.w && v.h ? Math.max(0.56, Math.min(1.6, v.h / v.w)) : 0.66);
  if (f === 'format:thread') h += 160 + Math.min(300, t) * 0.5;
  else if (!v && t <= 180) h += 40 + t * 0.9;
  else h += Math.min(t, 420) * 0.42 + 24;
  return h;
}
