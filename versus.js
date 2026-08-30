import {
  HandLandmarker,
  FilesetResolver,
} from "./vendor/tasks-vision/vision_bundle.mjs";

// ---------- Config ----------
const PER_SIDE = 50;            // aliens on each half
const IDLE_PER_SIDE = 9;        // ambient aliens per half on menus
const WIN_SCORE = 50;           // first to this many wins instantly
const GAME_SECONDS = 60;
const OVER_TIMEOUT_MS = 15000;  // return to start this long after the result shows
const ALIEN_SIZE = 78;
const EDGE_MARGIN = 0.06;       // inset from outer edges (keeps hands trackable)
const LINE_HALF = 5;            // half-width of the 10px center divider
const CENTER_GAP = 18;          // extra gap so aliens don't hug the divider
const CATCH_PADDING = 22;
const GRAB_FINGERS_NEEDED = 3;
const ARM_HOLD_MS = 1500;
const ALIENS_DIR = "Aliens/";

// ---------- DOM ----------
const video = document.getElementById("webcam");
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const hud = document.getElementById("hud");
const p1El = document.getElementById("p1-score");
const p2El = document.getElementById("p2-score");
const timeEl = document.getElementById("time");
const startScreen = document.getElementById("start-screen");
const overScreen = document.getElementById("over-screen");
const startStatus = document.getElementById("start-status");
const startArm = document.getElementById("start-arm");
const overArm = document.getElementById("over-arm");
const enableCamBtn = document.getElementById("enable-cam");
const winnerTitle = document.getElementById("winner-title");
const finalP1 = document.getElementById("final-p1");
const finalP2 = document.getElementById("final-p2");
const fsBtn = document.getElementById("fs-btn");

// ---------- State ----------
let handLandmarker = null;
let aliens = [];
let score1 = 0;
let score2 = 0;
let running = false;
let endTime = 0;
let lastVideoTime = -1;
let latestHands = [];
const latch = { left: false, right: false }; // one grab = one catch, per side

let cameraReady = false;
let armStart = 0;
let armLockUntil = 0;
let overShownAt = 0;

// ---------- Assets (shared with single-player game) ----------
let alienImages = [];

function loadImage(src) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = src;
  });
}

async function discoverAlienFiles() {
  try {
    const res = await fetch(ALIENS_DIR + "aliens.json", { cache: "no-store" });
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list) && list.length) {
        return list.map((name) => ALIENS_DIR + name);
      }
    }
  } catch (_) { /* fall through */ }
  try {
    const res = await fetch(ALIENS_DIR);
    const html = await res.text();
    const found = [...html.matchAll(/href="([^"]+\.(?:png|jpe?g|webp|gif))"/gi)]
      .map((m) => decodeURIComponent(m[1].split("/").pop()))
      .filter((n) => !/\.json$/i.test(n));
    return [...new Set(found)].map((name) => ALIENS_DIR + name);
  } catch (err) {
    console.error("Could not find alien images:", err);
    return [];
  }
}

async function loadAlienAssets() {
  const paths = await discoverAlienFiles();
  const imgs = await Promise.all(paths.map(loadImage));
  alienImages = imgs.filter(Boolean);
  return alienImages.length;
}

// ---------- Canvas sizing ----------
function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

// ---------- Hand tracking ----------
async function initHandTracking() {
  const vision = await FilesetResolver.forVisionTasks("vendor/tasks-vision/wasm");
  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: "vendor/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 2, // one per player
  });
}

async function startWebcam() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 1280, height: 720 },
    audio: false,
  });
  video.srcObject = stream;
  await new Promise((res) => (video.onloadedmetadata = res));
  await video.play();
}

// ---------- Side bounds ----------
function sideBounds(side) {
  const cx = canvas.width / 2;
  const r = ALIEN_SIZE / 2;
  const mx = canvas.width * EDGE_MARGIN;
  const my = canvas.height * EDGE_MARGIN;
  // account for the sprite radius so aliens never overlap the divider
  const innerLeft = cx - LINE_HALF - CENTER_GAP - r;
  const innerRight = cx + LINE_HALF + CENTER_GAP + r;
  if (side === 0) {
    return { minX: mx, maxX: innerLeft, minY: my, maxY: canvas.height - my };
  }
  return { minX: innerRight, maxX: canvas.width - mx, minY: my, maxY: canvas.height - my };
}

// ---------- Aliens ----------
function buildStyleAssignments(count) {
  const n = Math.max(1, alienImages.length);
  const base = Math.floor(count / n);
  const rem = count % n;
  const indices = [];
  for (let i = 0; i < n; i++) {
    const c = base + (i < rem ? 1 : 0);
    for (let k = 0; k < c; k++) indices.push(i);
  }
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices;
}

function spawnAliens(perSide) {
  aliens = [];
  for (let side = 0; side < 2; side++) {
    const b = sideBounds(side);
    const styles = buildStyleAssignments(perSide);
    for (let i = 0; i < perSide; i++) {
      const speed = 80 + Math.random() * 150;
      const angle = Math.random() * Math.PI * 2;
      aliens.push({
        x: b.minX + Math.random() * (b.maxX - b.minX),
        y: b.minY + Math.random() * (b.maxY - b.minY),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        wobble: Math.random() * Math.PI * 2,
        alive: true,
        pop: 0,
        side,
        img: alienImages[styles[i]] || null,
      });
    }
  }
}

function updateAliens(dt) {
  for (const a of aliens) {
    if (!a.alive) {
      if (a.pop > 0) a.pop -= dt * 3.6;
      continue;
    }
    a.x += a.vx * dt;
    a.y += a.vy * dt;
    a.wobble += dt * 5;
    const b = sideBounds(a.side);
    if (a.x < b.minX) { a.x = b.minX; a.vx *= -1; }
    if (a.x > b.maxX) { a.x = b.maxX; a.vx *= -1; }
    if (a.y < b.minY) { a.y = b.minY; a.vy *= -1; }
    if (a.y > b.maxY) { a.y = b.maxY; a.vy *= -1; }
  }
}

function drawAliens() {
  for (const a of aliens) {
    if (!a.alive && a.pop <= 0) continue;
    const bob = Math.sin(a.wobble) * 4;
    let size = ALIEN_SIZE;
    let alpha = 1;
    if (!a.alive) {
      size = ALIEN_SIZE * (1 + (1 - a.pop) * 0.8);
      alpha = Math.max(0, a.pop);
    }
    if (!a.img) continue;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(a.img, a.x - size / 2, a.y - size / 2 + bob, size, size);
    ctx.restore();
  }
}

function drawDivider() {
  ctx.save();
  ctx.fillStyle = "#39ff14";
  ctx.shadowColor = "rgba(57, 255, 20, 0.8)";
  ctx.shadowBlur = 16;
  ctx.fillRect(canvas.width / 2 - LINE_HALF, 0, LINE_HALF * 2, canvas.height);
  ctx.restore();
}

// ---------- Hand detection ----------
const FINGERS = [
  { tip: 8, pip: 6 },
  { tip: 12, pip: 10 },
  { tip: 16, pip: 14 },
  { tip: 20, pip: 18 },
];
const TIP_IDS = [4, 8, 12, 16, 20];

function toScreen(pt) {
  return { x: (1 - pt.x) * canvas.width, y: pt.y * canvas.height };
}

function processHands(result) {
  latestHands = [];
  if (!result || !result.landmarks) return;
  for (const lm of result.landmarks) {
    const wrist = lm[0];
    const palm = lm[9];
    let curled = 0;
    for (const f of FINGERS) {
      if (dist(lm[f.tip], wrist) < dist(lm[f.pip], wrist)) curled++;
    }
    const closed = curled >= GRAB_FINGERS_NEEDED;
    const tips = TIP_IDS.map((id) => toScreen(lm[id]));
    latestHands.push({
      x: (1 - palm.x) * canvas.width,
      y: palm.y * canvas.height,
      closed,
      tips,
    });
  }
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Pick one hand per side (the first found on that half)
function playerHands() {
  const cx = canvas.width / 2;
  let left = null, right = null;
  for (const h of latestHands) {
    if (h.x < cx) { if (!left) left = h; }
    else { if (!right) right = h; }
  }
  return { left, right };
}

function drawHands() {
  const cx = canvas.width / 2;
  for (const h of latestHands) {
    const side = h.x < cx ? 0 : 1;
    const base = side === 0 ? "#4db8ff" : "#ff9f40";
    const stroke = h.closed ? "#ff5470" : base;
    const fill = h.closed
      ? "rgba(255, 84, 112, 0.35)"
      : side === 0
      ? "rgba(77, 184, 255, 0.15)"
      : "rgba(255, 159, 64, 0.15)";
    ctx.save();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.5;
    for (const t of h.tips) {
      ctx.beginPath();
      ctx.moveTo(h.x, h.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = stroke;
    for (const t of h.tips) {
      ctx.beginPath();
      ctx.arc(t.x, t.y, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(h.x, h.y, h.closed ? 22 : 30, 0, Math.PI * 2);
    ctx.lineWidth = 4;
    ctx.strokeStyle = stroke;
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

// ---------- Catch logic ----------
function checkCatches() {
  const hands = playerHands();
  const hitRadius = ALIEN_SIZE / 2 + CATCH_PADDING;
  [["left", 0], ["right", 1]].forEach(([key, sideVal]) => {
    const h = hands[key];
    if (!h) { latch[key] = false; return; }
    if (h.closed) {
      if (!latch[key]) {
        for (const a of aliens) {
          if (!a.alive || a.side !== sideVal) continue;
          if (dist(h, a) < hitRadius) {
            a.alive = false;
            a.pop = 1;
            if (sideVal === 0) { score1++; p1El.textContent = score1; }
            else { score2++; p2El.textContent = score2; }
            break;
          }
        }
        latch[key] = true;
      }
    } else {
      latch[key] = false;
    }
  });
  if (score1 >= WIN_SCORE || score2 >= WIN_SCORE) endGame();
}

// ---------- Start / replay gesture: each player raises one hand ----------
function activeArmEl() {
  return overScreen.classList.contains("hidden") ? startArm : overArm;
}
function baseArmText() {
  return overScreen.classList.contains("hidden")
    ? "Each player raise one hand to start ✋ | ✋"
    : "Each player raise one hand to play again ✋ | ✋";
}
function setArm(text, counting) {
  const el = activeArmEl();
  el.textContent = text;
  el.classList.toggle("counting", !!counting);
}

function updateArming() {
  if (running) { armStart = 0; return; }
  if (!cameraReady || !handLandmarker) return;
  const now = performance.now();
  if (now < armLockUntil) { armStart = 0; setArm(baseArmText(), false); return; }

  const cx = canvas.width / 2;
  const hasLeft = latestHands.some((h) => h.x < cx);
  const hasRight = latestHands.some((h) => h.x >= cx);

  if (hasLeft && hasRight) {
    if (!armStart) armStart = now;
    const progress = (now - armStart) / ARM_HOLD_MS;
    if (progress >= 1) { armStart = 0; startGame(); return; }
    const cd = Math.max(1, Math.ceil(3 * (1 - progress)));
    setArm(`เริ่มใน ${cd}…  (Starting in ${cd})`, true);
  } else {
    armStart = 0;
    let hint = "Each player raise one hand ✋ | ✋";
    if (hasLeft && !hasRight) hint = "Waiting for Player 2 (right) ✋";
    else if (!hasLeft && hasRight) hint = "Waiting for Player 1 (left) ✋";
    setArm(hint, false);
  }
}

// ---------- Main loop ----------
let lastFrameTime = 0;
function loop() {
  const nowTs = performance.now();
  let dt = lastFrameTime ? (nowTs - lastFrameTime) / 1000 : 0;
  lastFrameTime = nowTs;
  if (dt > 0.05) dt = 0.05;

  if (handLandmarker && video.readyState >= 2) {
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const result = handLandmarker.detectForVideo(video, nowTs);
      processHands(result);
    }
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  updateAliens(dt);

  if (running) {
    checkCatches();
    const remaining = Math.max(0, Math.ceil((endTime - performance.now()) / 1000));
    timeEl.textContent = remaining;
    if (performance.now() >= endTime) endGame();
    drawDivider();
  } else {
    updateArming();
    if (
      !overScreen.classList.contains("hidden") &&
      overShownAt &&
      performance.now() - overShownAt >= OVER_TIMEOUT_MS
    ) {
      goToStart();
    }
  }

  drawAliens();
  drawHands();

  requestAnimationFrame(loop);
}

// ---------- Game flow ----------
function startGame() {
  score1 = 0;
  score2 = 0;
  p1El.textContent = 0;
  p2El.textContent = 0;
  timeEl.textContent = GAME_SECONDS;
  latch.left = false;
  latch.right = false;
  spawnAliens(PER_SIDE);
  endTime = performance.now() + GAME_SECONDS * 1000;
  running = true;
  startScreen.classList.add("hidden");
  overScreen.classList.add("hidden");
  hud.classList.remove("hidden");
}

function endGame() {
  if (!running) return;
  running = false;
  armStart = 0;
  armLockUntil = performance.now() + 1500;
  overShownAt = performance.now();
  hud.classList.add("hidden");

  finalP1.textContent = score1;
  finalP2.textContent = score2;

  const col1 = finalP1.closest(".fs-col");
  const col2 = finalP2.closest(".fs-col");
  col1.classList.remove("winner");
  col2.classList.remove("winner");

  if (score1 >= WIN_SCORE || score2 >= WIN_SCORE) {
    // instant win by reaching 50
    if (score1 >= WIN_SCORE) { winnerTitle.textContent = "🏆 Player 1 saved all 50 — WINS!"; col1.classList.add("winner"); }
    else { winnerTitle.textContent = "🏆 Player 2 saved all 50 — WINS!"; col2.classList.add("winner"); }
  } else if (score1 > score2) {
    winnerTitle.textContent = "🏆 Player 1 Wins!";
    col1.classList.add("winner");
  } else if (score2 > score1) {
    winnerTitle.textContent = "🏆 Player 2 Wins!";
    col2.classList.add("winner");
  } else {
    winnerTitle.textContent = "🤝 It's a Tie!";
  }

  overScreen.classList.remove("hidden");
}

function goToStart() {
  overShownAt = 0;
  armStart = 0;
  overScreen.classList.add("hidden");
  startScreen.classList.remove("hidden");
  spawnAliens(IDLE_PER_SIDE);
}

// ---------- Fullscreen ----------
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    (document.documentElement.requestFullscreen?.() || Promise.reject()).catch(() => {});
  } else {
    document.exitFullscreen?.();
  }
}
fsBtn.addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", () => {
  fsBtn.textContent = document.fullscreenElement ? "⛶ Exit Fullscreen" : "⛶ Fullscreen";
  resizeCanvas();
});

// ---------- Boot ----------
async function enableCamera() {
  startStatus.textContent = "Starting camera…";
  enableCamBtn.classList.add("hidden");
  try {
    await startWebcam();
    cameraReady = true;
    startStatus.textContent = "Camera ready ✔";
  } catch (err) {
    console.error(err);
    startStatus.textContent = "Camera blocked — click below to allow it.";
    enableCamBtn.classList.remove("hidden");
  }
}

async function boot() {
  const styleCount = await loadAlienAssets();
  if (styleCount === 0) {
    startStatus.textContent =
      "No alien images found. Put your images in the Aliens/ folder and reload.";
    requestAnimationFrame(loop);
    return;
  }
  spawnAliens(IDLE_PER_SIDE);

  try {
    await initHandTracking();
    startStatus.textContent = `Ready ✔ ${styleCount} alien styles — starting camera…`;
  } catch (err) {
    console.error(err);
    startStatus.textContent = "Failed to load hand tracking. Check your files.";
    requestAnimationFrame(loop);
    return;
  }
  await enableCamera();
  requestAnimationFrame(loop);
}

enableCamBtn.addEventListener("click", enableCamera);
boot();
