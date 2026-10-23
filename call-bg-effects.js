// Background effects for video calls on devices where Daily's own video
// processors aren't supported (iPhone, Android, the native app's WebView).
//
// Our own camera stream -> MediaPipe selfie segmentation (person mask) ->
// canvas composite (blurred camera / solid green / chosen image behind the
// person) -> canvas.captureStream() -> handed to Daily as the call's camera.
//
//   CallBgEffects.supported()                       -> can this device do it?
//   CallBgEffects.start(callObject, mode, imageUrl, deviceId)
//   CallBgEffects.stop(callObject)                  -> back to the plain camera
//   CallBgEffects.active                            -> is a pipeline running?
(function () {
  const TASKS_VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
  const MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';
  const OUT_W = 640, OUT_H = 480, FPS = 20;

  let segmenterPromise = null;
  async function getSegmenter() {
    if (!segmenterPromise) {
      segmenterPromise = (async () => {
        const vision = await import(TASKS_VISION + '/vision_bundle.mjs');
        const fileset = await vision.FilesetResolver.forVisionTasks(TASKS_VISION + '/wasm');
        const make = (delegate) => vision.ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL, delegate },
          runningMode: 'VIDEO',
          outputCategoryMask: false,
          outputConfidenceMasks: true,
        });
        try { return await make('GPU'); } catch { return await make('CPU'); }
      })().catch(e => { segmenterPromise = null; throw e; });
    }
    return segmenterPromise;
  }

  function supported() {
    const c = document.createElement('canvas');
    return typeof c.captureStream === 'function' && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && typeof WebAssembly === 'object';
  }

  let state = null; // { stream, video, out, raf, ... }

  async function start(callObject, mode, imageUrl, deviceId) {
    await stop(null); // tear down any previous pipeline, keep Daily as-is for now
    const segmenter = await getSegmenter();

    const stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: OUT_W }, height: { ideal: OUT_H } }
                      : { facingMode: 'user', width: { ideal: OUT_W }, height: { ideal: OUT_H } },
      audio: false,
    });
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.setAttribute('playsinline', '');
    video.srcObject = stream;
    await video.play();
    const vw = video.videoWidth || OUT_W, vh = video.videoHeight || OUT_H;

    const out = document.createElement('canvas'); out.width = vw; out.height = vh;
    const ctx = out.getContext('2d');
    const person = document.createElement('canvas'); person.width = vw; person.height = vh;
    const pctx = person.getContext('2d');
    const maskC = document.createElement('canvas');
    const mctx = maskC.getContext('2d');
    // Cheap blur that works everywhere (iOS Safari has no ctx.filter):
    // shrink the frame way down, then stretch it back up smoothed.
    const tiny = document.createElement('canvas'); tiny.width = Math.max(8, Math.round(vw / 16)); tiny.height = Math.max(6, Math.round(vh / 16));
    const tctx = tiny.getContext('2d');

    let bgImage = null;
    if (mode === 'image' && imageUrl) {
      bgImage = new Image();
      bgImage.src = imageUrl;
      try { await bgImage.decode(); } catch { bgImage = null; }
    }

    let maskData = null, lastTs = -1, stopped = false;
    const frameGap = 1000 / FPS;
    let lastFrame = 0;
    function drawBackground() {
      if (mode === 'blur') {
        tctx.drawImage(video, 0, 0, tiny.width, tiny.height);
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(tiny, 0, 0, vw, vh);
      } else if (mode === 'image' && bgImage) {
        const s = Math.max(vw / bgImage.width, vh / bgImage.height);
        const w = bgImage.width * s, h = bgImage.height * s;
        ctx.drawImage(bgImage, (vw - w) / 2, (vh - h) / 2, w, h);
      } else {
        ctx.fillStyle = '#00b140'; ctx.fillRect(0, 0, vw, vh);
      }
    }
    function tick(now) {
      if (stopped) return;
      state.raf = requestAnimationFrame(tick);
      if (now - lastFrame < frameGap || video.readyState < 2) return;
      lastFrame = now;
      const ts = Math.max(lastTs + 1, Math.round(performance.now()));
      lastTs = ts;
      let result;
      try { result = segmenter.segmentForVideo(video, ts); } catch { return; }
      const mask = result && result.confidenceMasks && result.confidenceMasks[0];
      if (!mask) return;
      const mw = mask.width, mh = mask.height;
      const conf = mask.getAsFloat32Array();
      if (maskC.width !== mw || maskC.height !== mh) { maskC.width = mw; maskC.height = mh; maskData = mctx.createImageData(mw, mh); }
      const d = maskData.data;
      for (let i = 0, j = 3; i < conf.length; i++, j += 4) d[j] = conf[i] * 255;
      mctx.putImageData(maskData, 0, 0);
      result.close && result.close();

      // Person only: camera frame kept where the mask is opaque.
      pctx.globalCompositeOperation = 'copy';
      pctx.drawImage(video, 0, 0, vw, vh);
      pctx.globalCompositeOperation = 'destination-in';
      pctx.imageSmoothingEnabled = true;
      pctx.drawImage(maskC, 0, 0, vw, vh);

      drawBackground();
      ctx.drawImage(person, 0, 0);
    }

    const outStream = out.captureStream(FPS);
    const track = outStream.getVideoTracks()[0];
    state = { stream, video, outStream, track, raf: 0, stop: () => { stopped = true; } };
    state.raf = requestAnimationFrame(tick);
    if (callObject) await callObject.setInputDevicesAsync({ videoSource: track });
    CallBgEffects.active = true;
  }

  async function stop(callObject, restoreDeviceId) {
    if (state) {
      state.stop();
      cancelAnimationFrame(state.raf);
      state.stream.getTracks().forEach(t => t.stop());
      state.outStream.getTracks().forEach(t => t.stop());
      state.video.srcObject = null;
      state = null;
    }
    CallBgEffects.active = false;
    if (callObject) {
      try {
        await callObject.setInputDevicesAsync(restoreDeviceId ? { videoDeviceId: restoreDeviceId } : { videoSource: true });
      } catch (e) { console.error('[call-bg] restoring camera failed', e); }
    }
  }

  const CallBgEffects = { supported, start, stop, active: false };
  window.CallBgEffects = CallBgEffects;
})();
