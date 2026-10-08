// Shared by live camera and video replay: identical model, options and fallback.
export async function createPoseEngine(delegate = 'GPU') {
  const {PoseLandmarker, FilesetResolver} = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
  const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
  const options = {
    baseOptions: {modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task', delegate},
    runningMode: 'VIDEO', numPoses: 1,
    minPoseDetectionConfidence: .6, minPosePresenceConfidence: .6, minTrackingConfidence: .6,
  };
  try { return await PoseLandmarker.createFromOptions(vision, options); }
  catch (error) {
    if (delegate === 'CPU') throw error;
    options.baseOptions.delegate = 'CPU';
    return PoseLandmarker.createFromOptions(vision, options);
  }
}
