/**
 * The isometric camera, as maths rather than as a renderer.
 *
 * Everything the camera is for — where the eye sits, which way "up the screen"
 * points on the ground, where a pixel lands in the world — is a function of one
 * angle. Keeping that here, with no three.js in sight, means the two things
 * that are easy to get wrong and hard to see can be asserted in node instead of
 * squinted at:
 *
 *   1. movement stays camera-relative across a 90 degree snap, so "up" is still
 *      up after you rotate the view;
 *   2. a mouse point and a stick direction that mean the same thing produce the
 *      same facing.
 *
 * The page builds a THREE.OrthographicCamera from `eye` and `VIEW` and points
 * it at the same target, so there is one source of truth for the angle and the
 * renderer is a consumer of it.
 *
 * Handedness, once, because every sign below depends on it: y is up, the eye
 * looks down `forward`, screen-right is `right`, screen-up is `up`, and
 * `forward` flattened onto the ground is the direction "press up" walks.
 */
import { sin, cos, hyp, TAU } from '../gen/exact.mjs';
import { clamp } from '../gen/constants.mjs';

/** 45 degrees of elevation. The angle the whole game is drawn at. */
export const PITCH = TAU / 8;
/** The snap step. The plate rotates in quarters and so does this. */
export const QUARTER = TAU / 4;
/** Where the view starts: the corner the concept plate has always used. */
export const START_YAW = TAU / 8;
/** Eye distance. Orthographic, so this only buys clipping headroom. */
export const EYE_DIST = 140;
/**
 * Half the visible height, in metres. Sets the zoom, and it is a design number
 * rather than a taste one: at 45° a metre of screen height covers root-two
 * metres of ground, so 10 here frames about 20 x 28 m of world — close enough
 * that a 1.8 m character reads as a character, wide enough that a 5 m canyon
 * and its far rim are both on screen when you have to judge the jump.
 */
export const VIEW = 10;
/** Fraction of the remaining gap the follow closes each tick. */
export const FOLLOW = 0.12;
/** Same, for the yaw easing between snaps. */
export const YAW_EASE = 0.14;
/** How far above the actor's feet the camera actually looks. */
export const EYE_HEIGHT = 1.0;

/** The horizontal and vertical leg of the eye offset — equal, hence 45°. */
const LEG = EYE_DIST * cos(PITCH);

export function makeCamera(opts) {
  const o = opts || {};
  return {
    yaw: o.yaw === undefined ? START_YAW : o.yaw,
    /** Where the yaw is easing to. Snaps move this; `yaw` catches up. */
    yawTo: o.yaw === undefined ? START_YAW : o.yaw,
    tx: o.tx || 0, ty: o.ty || 0, tz: o.tz || 0,
    view: o.view === undefined ? VIEW : o.view,
  };
}

/** Turn the view a quarter. dir is -1 or +1. */
export function snap(cam, dir) { cam.yawTo += (dir < 0 ? -QUARTER : QUARTER); return cam; }

/** Put the camera on a target immediately — spawning, or a respawn. */
export function warpTo(cam, x, y, z) {
  cam.tx = x; cam.ty = y + EYE_HEIGHT; cam.tz = z;
  cam.yaw = cam.yawTo;
  return cam;
}

/** One tick of easing: the target is chased, and so is the snap. */
export function follow(cam, x, y, z) {
  cam.tx += (x - cam.tx) * FOLLOW;
  cam.ty += (y + EYE_HEIGHT - cam.ty) * FOLLOW;
  cam.tz += (z - cam.tz) * FOLLOW;
  cam.yaw += (cam.yawTo - cam.yaw) * YAW_EASE;
  return cam;
}

/** Where the eye sits. The renderer wants this and nothing else. */
export function eye(cam) {
  return { x: cam.tx + sin(cam.yaw) * LEG, y: cam.ty + LEG, z: cam.tz + cos(cam.yaw) * LEG };
}

/**
 * The view basis. `forward` runs eye to target, `right` is screen-right and
 * `up` is screen-up; `fx,fz` and `rx,rz` are forward and right flattened onto
 * the ground, which is what movement and aim are expressed in.
 */
export function basis(cam) {
  const s = sin(cam.yaw), c = cos(cam.yaw), k = 1 / hyp(1, 1);
  return {
    fx: -s, fz: -c,                       /* ground-plane forward, unit */
    rx: c, rz: -s,                        /* ground-plane right, unit   */
    f: { x: -s * k, y: -k, z: -c * k },
    r: { x: c, y: 0, z: -s },
    u: { x: -s * k, y: k, z: -c * k },
  };
}

/** Length of a ground vector. */
function len2(x, z) { return hyp(x, z); }

/**
 * A screen-space heading turned into a world-space one.
 *
 * `ix` is right on screen, `iy` is up the screen, and both are -1..1. The
 * result is never longer than 1, so a diagonal on the keyboard is not faster
 * than a straight line — and pushing a stick half way still walks half speed.
 */
export function moveFrom(cam, ix, iy) {
  const b = basis(cam);
  const mag = len2(ix, iy);
  const k = mag > 1 ? 1 / mag : 1;
  return { mx: (b.rx * ix + b.fx * iy) * k, mz: (b.rz * ix + b.fz * iy) * k };
}

/** Pixels per metre. Square, so a metre is a metre in both axes. */
function ppm(cam, vp) { return (vp.h / 2) / cam.view; }

/** Where a world point lands on screen, in pixels from the top left. */
export function project(cam, p, vp) {
  const b = basis(cam), k = ppm(cam, vp);
  const dx = p.x - cam.tx, dy = p.y - cam.ty, dz = p.z - cam.tz;
  const sx = dx * b.r.x + dy * b.r.y + dz * b.r.z;
  const sy = dx * b.u.x + dy * b.u.y + dz * b.u.z;
  return { x: vp.w / 2 + sx * k, y: vp.h / 2 - sy * k };
}

/** Where a screen pixel meets the horizontal plane at height `y`. */
export function groundAt(cam, sx, sy, vp, y) {
  const b = basis(cam), k = ppm(cam, vp);
  const mr = (sx - vp.w / 2) / k, mu = (vp.h / 2 - sy) / k;
  const px = cam.tx + b.r.x * mr + b.u.x * mu;
  const py = cam.ty + b.r.y * mr + b.u.y * mu;
  const pz = cam.tz + b.r.z * mr + b.u.z * mu;
  const t = (y - py) / b.f.y;                 /* f.y is never 0 at 45° */
  return { x: px + b.f.x * t, z: pz + b.f.z * t };
}

/** Unit ground direction from one point to another, or null if they coincide. */
export function heading(fromX, fromZ, toX, toZ) {
  const dx = toX - fromX, dz = toZ - fromZ, l = len2(dx, dz);
  return l < 1e-9 ? null : { x: dx / l, z: dz / l };
}

/**
 * Mouse free-aim: face the point under the cursor, on the plane the actor is
 * standing on. A point, which is what issue #1 has to reconcile with the stick;
 * for Phase 0 only its direction is used.
 */
export function aimFromPointer(cam, sx, sy, vp, actor) {
  const g = groundAt(cam, sx, sy, vp, actor.y);
  return heading(actor.x, actor.z, g.x, g.z);
}

/**
 * Twin-stick free-aim: a direction, read in the same screen-space basis as
 * movement, so the two devices agree by construction rather than by tuning.
 */
export function aimFromStick(cam, ax, ay) {
  if (len2(ax, ay) < 0.25) return null;       /* a dead zone, not a direction */
  const m = moveFrom(cam, ax, ay), l = len2(m.mx, m.mz);
  return l < 1e-9 ? null : { x: m.mx / l, z: m.mz / l };
}

/** Clamp the zoom to something a 45° view can actually use. */
export function setView(cam, v) { cam.view = clamp(v, 6, 40); return cam; }
