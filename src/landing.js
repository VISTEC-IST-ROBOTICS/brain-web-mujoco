// Robot menu shown when the page is opened without a (known) ?robot=. Each
// card links to ?robot=<name>, so every robot keeps its own shareable URL.
// Below the robots, a section with a card for the robot summon page.

// robots: [{ name, title, description, thumbnail, controllable, watchable }]
export function showLanding(robots, requested) {
  document.getElementById('hud').remove();
  const root = document.createElement('div');
  root.id = 'landing';
  root.innerHTML = `
    <header>
      <img class="logo" src="assets/brain_logo_v2.webp" alt="BRAIN VISTEC">
      <h1>Robots @ BRAIN-VISTEC</h1>
      <p>Pick a robot and observe them right here in your browser.</p>
    </header>
    ${requested ? `<p class="notice">There's no robot called “${escapeHtml(requested)}”. Pick one below.</p>` : ''}
    ${robots.length
    // Robots you can drive first, then ones that run on their own.
    ? `<ul class="cards">${[...robots].sort((a, b) => b.controllable - a.controllable).map(card).join('')}</ul>`
    : '<p class="notice">No robots are available yet: add one in python/robots/ (see python/README.md).</p>'}
    <section class="summon">
      <h2 class="section-title">Robot Summon</h2>
      <a class="card summon-card" href="summon.html">
        <div class="art" aria-hidden="true">
          <div class="mini-box"><i class="lid"></i><i class="crate"><img src="assets/brain_logo_v2.webp" alt=""></i></div>
        </div>
        <div class="info">
          <h2>Summon a robot</h2>
          <p>Open a box to get a random robot in one of 16 colours, from Common to Legendary,
            and collect them all in the Robodex. Then take your pick for a walk.</p>
          <span class="go">Summon &rarr;</span>
        </div>
      </a>
    </section>`;
  document.getElementById('app').appendChild(root);
}

function card({ name, title, description, thumbnail, controllable, watchable }) {
  const label = title || name;
  const thumb = thumbnail
    ? `<img src="${escapeHtml(thumbnail)}" alt="" loading="lazy">`
    : `<span class="placeholder" style="--hue:${hue(name)}">${escapeHtml(label[0].toUpperCase())}</span>`;
  return `<li><a class="card" href="?robot=${encodeURIComponent(name)}">
    <div class="thumb">${thumb}${controllable
      ? `<span class="mode drive" title="You control this robot with the keyboard, a gamepad or the touch joystick${
        watchable ? ', or switch to Watch and let it walk on its own' : ''}">Drive${watchable ? ' · Watch' : ''}</span>`
      : '<span class="mode watch" title="This robot moves on its own">Watch</span>'}</div>
    <div class="info">
      <h2>${escapeHtml(label)}</h2>
      ${description ? `<p>${escapeHtml(description)}</p>` : ''}
    </div>
  </a></li>`;
}

// Stable colour per robot for cards without a thumbnail.
function hue(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
