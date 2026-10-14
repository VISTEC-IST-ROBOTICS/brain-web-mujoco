// "Thumbnail" in the MJCF tab: makes the picture on the robot's card in the robot menu, an
// 800 x 500 JPEG like the others in public/assets/thumbs/. The MJCF view has the robot page's
// look (lights, floor, logo sign), so the picture matches; turn and zoom the view, pose the
// robot with the joint sliders (or let it walk with Simulate), then capture what is in the frame.

const WIDTH = 800;
const HEIGHT = 500; // the cards are 16:10
const MARGIN = 12;

export function createThumbnail(viewer, ui) {
  let on = false;
  let rect = null; // the frame, in pane pixels
  let jpeg = null; // the last capture (a Blob)
  let previewUrl = null;

  // The largest 16:10 frame between the toolbar, the joints panel and the bar at the bottom
  function placeFrame() {
    if (!on) return;
    const pane = ui.pane;
    const top = ui.toolbar.offsetTop + ui.toolbar.offsetHeight + MARGIN;
    const right = ui.joints.hidden ? pane.clientWidth - MARGIN : ui.joints.offsetLeft - MARGIN;
    const bottom = ui.bar.offsetTop - MARGIN;
    const [aw, ah] = [right - MARGIN, bottom - top];
    const w = Math.max(80, Math.min(aw, ah * WIDTH / HEIGHT));
    const h = w * HEIGHT / WIDTH;
    rect = { x: MARGIN + (aw - w) / 2, y: top + (ah - h) / 2, w, h };
    Object.assign(ui.frame.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${w}px`, height: `${h}px` });
    requestAnimationFrame(placeFrame); // follows the pane's size and the joints panel
  }

  function start() {
    if (!viewer.target || on) return;
    on = true;
    ui.frame.hidden = ui.bar.hidden = false;
    ui.toggle.classList.add('on');
    ui.others.forEach((el) => { el.disabled = true; });
    const { robot } = viewer.target;
    ui.save.hidden = !robot;
    ui.note.textContent = robot
      ? `Saved as ${robot.thumbnail ? robot.thumbnail.replace('/repo/', '') : `public/assets/thumbs/${robot.name}.jpg`}, `
        + `the card picture of ${robot.file}.`
      : 'No python/robots file uses this model yet, so it can only be downloaded.';
    ui.status.textContent = '';
    showCapture(null);
    placeFrame();
  }

  function stop() {
    if (!on) return;
    on = false;
    ui.frame.hidden = ui.bar.hidden = true;
    ui.toggle.classList.remove('on');
    ui.others.forEach((el) => { el.disabled = false; });
  }

  function showCapture(blob) {
    jpeg = blob;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = blob && URL.createObjectURL(blob);
    ui.preview.hidden = !blob;
    if (blob) ui.preview.src = previewUrl;
    ui.save.disabled = !blob;
    ui.download.hidden = !blob;
    if (blob) ui.download.href = previewUrl;
    ui.download.download = `${viewer.target?.robot?.name ?? 'thumbnail'}.jpg`;
  }

  ui.capture.onclick = async () => {
    const canvas = viewer.stage.snapshot(rect, WIDTH, HEIGHT);
    showCapture(await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88)));
    ui.status.textContent = '';
  };

  ui.save.onclick = async () => {
    const { url, robot } = viewer.target;
    const file = robot.thumbnail ? robot.thumbnail.replace('/repo/', '') : `public/assets/thumbs/${robot.name}.jpg`;
    const also = robot.thumbnail ? '' : ` and set THUMBNAIL in ${robot.file}`;
    if (!confirm(`This writes ${file}${also}. Save?`)) return;
    ui.save.disabled = true;
    ui.status.textContent = 'Saving…';
    try {
      const res = await fetch(`/api/thumbnail?url=${encodeURIComponent(url)}`, { method: 'POST', body: jpeg });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error ?? res.status);
      robot.thumbnail = r.thumbnail;
      ui.status.textContent = `Saved: ${r.files.join(', ')}.`;
    } catch (e) {
      ui.status.textContent = `Not saved: ${e.message ?? e}`;
    } finally {
      ui.save.disabled = false;
    }
  };

  ui.toggle.onclick = () => (on ? stop() : start());
  ui.close.onclick = stop;
  viewer.on('clear', () => { stop(); ui.toggle.disabled = true; });
  viewer.on('load', () => { ui.toggle.disabled = false; });
  ui.toggle.disabled = true;
  return { get active() { return on; } };
}
