import {
  HandLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18";

// ---------- Config ----------
const ALIEN_COUNT = 50;
const IDLE_COUNT = 18;          // aliens drifting in the background on menus
const OVER_TIMEOUT_MS = 10000;  // return to start screen this long after score shows
const GAME_SECONDS = 30;
const ALIEN_SIZE = 90;          // drawn diameter in px
const CATCH_PADDING = 24;       // extra forgiveness on the hit radius
const GRAB_FINGERS_NEEDED = 3;  // how many curled fingers count as a "grab" (of 4)
const ALIENS_DIR = "Aliens/";   // all image files in here are used as alien styles

// ---------- DOM ----------
const video = document.getElementById("webcam");
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const hud = document.getElementById("hud");
const scoreEl = document.getElementById("score");
const timeEl = document.getElementById("time");
const startScreen = document.getElementById("start-screen");
const overScreen = document.getElementById("over-screen");
const startStatus = document.getElementById("start-status");
const startArm = document.getElementById("start-arm");
const overArm = document.getElementById("over-arm");
const enableCamBtn = document.getElementById("enable-cam");
const finalScoreEl = document.getElementById("final-score");
const rankEl = document.getElementById("rank");
const fsBtn = document.getElementById("fs-btn");

// ---------- State ----------
let handLandmarker = null;
let aliens = [];
let score = 0;
let running = false;
let endTime = 0;
let lastVideoTime = -1;
let latestHands = [];           // [{x, y, closed}] in canvas pixels
// per-hand latch so one grab = one catch (keyed by hand index)
const handLatched = [false, false];

// "Raise both hands" start gesture
let cameraReady = false;
let armStart = 0;               // timestamp when both hands first raised
let armLockUntil = 0;           // ignore arming until this time (post-game cooldown)
let overShownAt = 0;            // when the game-over screen appeared (for auto-return)
const ARM_HOLD_MS = 1500;       // how long to hold both hands up to start

// ---------- Assets ----------
// Alien styles are auto-discovered from the Aliens/ folder at runtime, so any
// filenames work — just drop the images in. The 50 aliens are split as evenly
// as possible across all styles found.
let alienImages = []; // loaded HTMLImageElement[]

function loadImage(src) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = src;
  });
}

// Find the alien images. Prefers Aliens/aliens.json (works on ANY web host,
// including GitHub Pages / Netlify). Falls back to reading the directory
// listing, which works with a local `python -m http.server`.
async function discoverAlienFiles() {
  // 1) Manifest — the reliable, host-agnostic way
  try {
    const res = await fetch(ALIENS_DIR + "aliens.json", { cache: "no-store" });
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list) && list.length) {
        return list.map((name) => ALIENS_DIR + name);
      }
    }
  } catch (_) { /* no manifest — try directory listing */ }

  // 2) Directory listing (local dev servers only)
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

// ---------- Setup hand tracking ----------
async function initHandTracking() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm"
  );
  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 2,
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

// ---------- Aliens ----------
// Build a list of 50 style indices split as evenly as possible across the
// available images (e.g. 6 styles -> 9,9,8,8,8,8), then shuffle so they mix.
function buildStyleAssignments(count) {
  const n = Math.max(1, alienImages.length);
  const base = Math.floor(count / n);
  const rem = count % n;
  const indices = [];
  for (let i = 0; i < n; i++) {
    const count = base + (i < rem ? 1 : 0);
    for (let k = 0; k < count; k++) indices.push(i);
  }
  // Fisher–Yates shuffle
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices;
}

function spawnAliens(count = ALIEN_COUNT) {
  aliens = [];
  const r = ALIEN_SIZE / 2;
  const styles = buildStyleAssignments(count);
  for (let i = 0; i < count; i++) {
    const speed = 80 + Math.random() * 150; // pixels per second
    const angle = Math.random() * Math.PI * 2;
    aliens.push({
      x: r + Math.random() * (canvas.width - ALIEN_SIZE),
      y: r + Math.random() * (canvas.height - ALIEN_SIZE),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      wobble: Math.random() * Math.PI * 2,
      alive: true,
      pop: 0, // >0 while playing catch animation
      img: alienImages[styles[i]] || null,
    });
  }
}

function updateAliens(dt) {
  const r = ALIEN_SIZE / 2;
  for (const a of aliens) {
    if (!a.alive) {
      if (a.pop > 0) a.pop -= dt * 3.6;
      continue;
    }
    a.x += a.vx * dt;
    a.y += a.vy * dt;
    a.wobble += dt * 5;
    // bounce off walls
    if (a.x < r) { a.x = r; a.vx *= -1; }
    if (a.x > canvas.width - r) { a.x = canvas.width - r; a.vx *= -1; }
    if (a.y < r) { a.y = r; a.vy *= -1; }
    if (a.y > canvas.height - r) { a.y = canvas.height - r; a.vy *= -1; }
  }
}

function drawAliens() {
  for (const a of aliens) {
    if (!a.alive && a.pop <= 0) continue;
    const bob = Math.sin(a.wobble) * 4;
    let size = ALIEN_SIZE;
    let alpha = 1;
    if (!a.alive) {
      // pop animation: grow + fade out
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

// ---------- Hand detection ----------
// Finger joints: [fingertip, PIP joint]. A finger is "curled" when its tip
// is closer to the wrist than its PIP joint — distance-invariant, so it works
// whether the hand is near or far from the camera.
const FINGERS = [
  { tip: 8, pip: 6 },   // index
  { tip: 12, pip: 10 }, // middle
  { tip: 16, pip: 14 }, // ring
  { tip: 20, pip: 18 }, // pinky
];
const TIP_IDS = [4, 8, 12, 16, 20]; // thumb + 4 fingertips (for drawing)

function toScreen(pt) {
  return { x: (1 - pt.x) * canvas.width, y: pt.y * canvas.height };
}

function processHands(result) {
  latestHands = [];
  if (!result || !result.landmarks) return;

  for (const lm of result.landmarks) {
    const wrist = lm[0];
    const palm = lm[9]; // middle-finger knuckle ≈ palm center

    // Count curled fingers
    let curled = 0;
    for (const f of FINGERS) {
      if (dist(lm[f.tip], wrist) < dist(lm[f.pip], wrist)) curled++;
    }
    const closed = curled >= GRAB_FINGERS_NEEDED;

    // Screen-space fingertips (mirrored) for drawing
    const tips = TIP_IDS.map((id) => toScreen(lm[id]));

    latestHands.push({
      x: (1 - palm.x) * canvas.width,
      y: palm.y * canvas.height,
      closed,
      curled,
      tips,
    });
  }
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function drawHands() {
  for (const h of latestHands) {
    const color = h.closed ? "#ff5470" : "#7cff9b";
    ctx.save();

    // Line from palm to each fingertip
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.5;
    for (const t of h.tips) {
      ctx.beginPath();
      ctx.moveTo(h.x, h.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Fingertip dots (all 5)
    ctx.fillStyle = color;
    for (const t of h.tips) {
      ctx.beginPath();
      ctx.arc(t.x, t.y, 7, 0, Math.PI * 2);
      ctx.fill();
    }

    // Palm ring — fills red when grabbing
    ctx.beginPath();
    ctx.arc(h.x, h.y, h.closed ? 24 : 32, 0, Math.PI * 2);
    ctx.lineWidth = 4;
    ctx.strokeStyle = color;
    ctx.fillStyle = h.closed
      ? "rgba(255, 84, 112, 0.35)"
      : "rgba(124, 255, 155, 0.12)";
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

// ---------- Catch logic ----------
function checkCatches() {
  const hitRadius = ALIEN_SIZE / 2 + CATCH_PADDING;
  latestHands.forEach((h, i) => {
    const idx = i < 2 ? i : 0;
    if (h.closed) {
      if (!handLatched[idx]) {
        // find nearest alive alien under the hand
        for (const a of aliens) {
          if (!a.alive) continue;
          if (dist({ x: h.x, y: h.y }, a) < hitRadius) {
            a.alive = false;
            a.pop = 1;
            score++;
            scoreEl.textContent = score;
            handLatched[idx] = true;
            if (score >= ALIEN_COUNT) endGame();
            break; // one catch per grab
          }
        }
        handLatched[idx] = true; // latch even if nothing caught, until hand opens
      }
    } else {
      handLatched[idx] = false; // hand opened -> ready to grab again
    }
  });
  // if a hand disappears, reset its latch
  if (latestHands.length < 2) handLatched[1] = false;
  if (latestHands.length < 1) handLatched[0] = false;
}

// ---------- "Raise both hands" start gesture ----------
function activeArmEl() {
  return overScreen.classList.contains("hidden") ? startArm : overArm;
}

function setArm(text, counting) {
  const el = activeArmEl();
  el.textContent = text;
  el.classList.toggle("counting", !!counting);
}

function baseArmText() {
  return overScreen.classList.contains("hidden")
    ? "Raise both hands to start ✋✋"
    : "Raise both hands to play again ✋✋";
}

// A hand counts as "raised" when it's in the upper ~75% of the frame
function handRaised(h) {
  return h.y < canvas.height * 0.8;
}

function updateArming() {
  if (running) { armStart = 0; return; }
  if (!cameraReady || !handLandmarker) return;

  const now = performance.now();
  if (now < armLockUntil) { armStart = 0; setArm(baseArmText(), false); return; }

  const raisedHands = latestHands.filter(handRaised).length;
  if (raisedHands >= 2) {
    if (!armStart) armStart = now;
    const progress = (now - armStart) / ARM_HOLD_MS;
    if (progress >= 1) {
      armStart = 0;
      startGame();
      return;
    }
    const countdown = Math.max(1, Math.ceil(3 * (1 - progress)));
    setArm(`เริ่มใน ${countdown}…  (Starting in ${countdown})`, true);
  } else {
    armStart = 0;
    setArm(baseArmText(), false);
  }
}

// ---------- Main loop ----------
let lastFrameTime = 0;
function loop() {
  // Delta time in seconds (clamped so a backgrounded tab doesn't teleport aliens)
  const nowTs = performance.now();
  let dt = lastFrameTime ? (nowTs - lastFrameTime) / 1000 : 0;
  lastFrameTime = nowTs;
  if (dt > 0.05) dt = 0.05;

  // Run hand detection on new video frames
  if (handLandmarker && video.readyState >= 2) {
    const now = performance.now();
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const result = handLandmarker.detectForVideo(video, now);
      processHands(result);
    }
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Aliens keep drifting at all times (gameplay + idle menus)
  updateAliens(dt);

  if (running) {
    checkCatches();
    // timer
    const remaining = Math.max(0, Math.ceil((endTime - performance.now()) / 1000));
    timeEl.textContent = remaining;
    if (performance.now() >= endTime) endGame();
  } else {
    updateArming();
    // Auto-return to the start screen if the score has been up for a while
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
  score = 0;
  scoreEl.textContent = 0;
  timeEl.textContent = GAME_SECONDS;
  spawnAliens();
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
  armLockUntil = performance.now() + 1500; // brief pause before restart gesture arms
  overShownAt = performance.now();
  hud.classList.add("hidden");
  finalScoreEl.textContent = score;
  rankEl.textContent = rankFor(score);
  overScreen.classList.remove("hidden");
}

// Return to the start screen (from the game-over screen) and refresh the
// ambient background aliens.
function goToStart() {
  overShownAt = 0;
  armStart = 0;
  overScreen.classList.add("hidden");
  startScreen.classList.remove("hidden");
  spawnAliens(IDLE_COUNT);
}

function rankFor(s) {
  if (s >= 50) return "🏆 PERFECT! All aliens caught!";
  if (s >= 40) return "🌟 Alien Master!";
  if (s >= 25) return "🚀 Great catching!";
  if (s >= 10) return "👍 Nice try!";
  return "👽 The aliens got away…";
}

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
  // Load alien artwork from the Aliens/ folder
  const styleCount = await loadAlienAssets();
  if (styleCount === 0) {
    startStatus.textContent =
      "No alien images found. Put your images in the Aliens/ folder and reload.";
    requestAnimationFrame(loop);
    return;
  }

  // Ambient aliens drifting behind the start screen
  spawnAliens(IDLE_COUNT);

  try {
    await initHandTracking();
    startStatus.textContent = `Ready ✔ ${styleCount} alien styles loaded — starting camera…`;
  } catch (err) {
    console.error(err);
    startStatus.textContent = "Failed to load hand tracking. Check your connection.";
    requestAnimationFrame(loop);
    return;
  }
  // Try to start the camera automatically; fall back to a button if blocked.
  await enableCamera();
  requestAnimationFrame(loop);
}

enableCamBtn.addEventListener("click", enableCamera);

// ---------- Fullscreen toggle ----------
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    (document.documentElement.requestFullscreen?.() ||
      Promise.reject()).catch(() => {});
  } else {
    document.exitFullscreen?.();
  }
}
fsBtn.addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", () => {
  fsBtn.textContent = document.fullscreenElement ? "⛶ Exit Fullscreen" : "⛶ Fullscreen";
  resizeCanvas();
});

boot();
