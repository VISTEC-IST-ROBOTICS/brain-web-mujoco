// Screenshot button: a shareable picture of the robot on the pedestal with
// its name, stars and tier, and the lab logo, as a 1080 x 1350 PNG (4:5,
// the shape photo apps and chats show whole). Saved as a download; on phones
// the share sheet opens instead when the browser can share files, so it can
// go straight to Photos or a chat.
import { TIERS } from './variants.js';

const W = 1080;
const H = 1350;
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

const logo = new Image();
logo.src = 'assets/brain_logo_v2.webp';

export async function saveScreenshot(stage, robot, variant) {
  const canvas = await drawScreenshot(stage, robot, variant);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const file = new File([blob], `${variant.id}-${robot.name}.png`.replace(/_/g, '-'), { type: 'image/png' });

  const phone = matchMedia('(pointer: coarse)').matches;
  if (phone && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: `${variant.name} ${robot.title}` });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return; // closed the share sheet
      // otherwise fall back to a download
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function drawScreenshot(stage, robot, variant) {
  const tier = TIERS[variant.tier];
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // The page's background, with the tier's colour glowing behind the robot.
  let g = ctx.createRadialGradient(W / 2, 0, 0, W / 2, 0, H * 0.9);
  g.addColorStop(0, '#1d2a38');
  g.addColorStop(1, '#111111');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  g = ctx.createRadialGradient(W / 2, 560, 0, W / 2, 560, 520);
  g.addColorStop(0, `${tier.color}40`);
  g.addColorStop(1, `${tier.color}00`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.drawImage(stage.snapshot(W, 860), 0, 150);

  // Header: the lab logo on a white badge, and the page's name.
  await logo.decode().catch(() => {});
  if (logo.naturalWidth) {
    const h = 64;
    const w = h * logo.naturalWidth / logo.naturalHeight;
    roundRect(ctx, 56, 56, w + 32, h + 24, 14, '#ffffff');
    ctx.drawImage(logo, 72, 68, w, h);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#9aa4ad';
  ctx.font = `600 30px ${FONT}`;
  ctx.fillText('Robot Summon', W - 60, 100);

  // The result: stars, tier, name, description.
  ctx.textAlign = 'center';
  ctx.font = `48px ${FONT}`;
  const stars = '★'.repeat(tier.stars);
  const empty = '★'.repeat(4 - tier.stars);
  const starsWidth = ctx.measureText(stars + empty).width;
  ctx.textAlign = 'left';
  ctx.fillStyle = tier.color;
  ctx.fillText(stars, (W - starsWidth) / 2, 1062);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.fillText(empty, (W - starsWidth) / 2 + ctx.measureText(stars).width, 1062);

  ctx.textAlign = 'center';
  ctx.fillStyle = tier.color;
  ctx.font = `800 30px ${FONT}`;
  ctx.letterSpacing = '4px';
  ctx.fillText(tier.label.toUpperCase(), W / 2, 1122);
  ctx.letterSpacing = '0px';

  ctx.fillStyle = '#eeeeee';
  ctx.font = `800 68px ${FONT}`;
  ctx.fillText(`${variant.name} ${robot.title}`, W / 2, 1196, W - 120);

  if (robot.description) {
    ctx.fillStyle = '#aab4c0';
    ctx.font = `30px ${FONT}`;
    ctx.fillText(robot.description, W / 2, 1262, W - 120);
  }
  return canvas;
}

function roundRect(ctx, x, y, w, h, r, fill) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}
