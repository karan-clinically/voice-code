// Minimal mic recorder for desktop push-to-talk. start() returns a handle whose
// stop() resolves to the recorded Blob and releases the mic.
export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mr = new MediaRecorder(stream);
  const chunks = [];
  mr.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
  mr.start();
  return {
    stop: () =>
      new Promise((resolve) => {
        mr.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          resolve(new Blob(chunks, { type: mr.mimeType || 'audio/webm' }));
        };
        mr.stop();
      }),
  };
}
