/**
 * The source hash the playable build shows beside a `dev` build label.
 *
 * A published artifact is stamped with its commit (QS_BUILD), and that is
 * what its location bar and its crash reports say. A copy that was not
 * stamped — GitHub Pages, which serves the repo file as it is, or a page
 * opened from disk — says `dev`, which identifies nothing. So the page also
 * hashes its own code: the inlined bundle and the page script, with the
 * stamp put back to `dev` so a stamped and an unstamped copy of one commit
 * agree. This is that same hash, computed from the file, so a hash read off
 * a screenshot can be matched to a commit (tools/which-build.mjs).
 *
 * FNV-1a over UTF-16 code units, as the page computes it over textContent.
 */
export function srcHash(html) {
  const text = html.replace(/\r\n?/g, '\n');
  const grab = (open) => {
    const a = text.indexOf(open);
    if (a < 0) return '';
    const b = text.indexOf('</script>', a + open.length);
    return text.slice(a + open.length, b);
  };
  const bundle = grab('<script id="qsbundle">');
  /* The page script is the one bare <script> tag after the bundle. */
  const after = text.indexOf('</script>', text.indexOf('<script id="qsbundle">'));
  const mainAt = text.indexOf('<script>', after);
  const main = mainAt < 0 ? '' : text.slice(mainAt + 8, text.indexOf('</script>', mainAt + 8));
  const t = (bundle + '\n' + main).replace(/var QS_BUILD='[^']*';/, "var QS_BUILD='dev';");
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 7);
}
