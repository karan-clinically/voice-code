// Spoken replies, played one after another.
//
// Every speaker in the app used to grab the audio itself: the auto-speak path set
// .src on a shared element, and each replay button built its own `new Audio()`. So
// a reply landing while an earlier one was still being read either cut it off
// mid-sentence or talked over it — and the half you were listening to was gone.
// Everything now goes through one element and one queue: a new clip waits for the
// current one to finish. stopSpeech() is the deliberate interrupt and drops what
// is still waiting, rather than letting it start after the silence.

let el = null;
let tail = Promise.resolve();
let epoch = 0;

function element() {
  if (!el) {
    el = new Audio();
    el.preload = 'auto';
  }
  return el;
}

function playOnce(url) {
  return new Promise((resolve) => {
    const a = element();
    const finish = () => {
      a.onended = null;
      a.onerror = null;
      resolve();
    };
    a.onended = finish;
    a.onerror = finish;
    a.src = url;
    const p = a.play();
    if (p && p.catch) p.catch(finish); // autoplay refused — don't stall the queue
  });
}

// Resolves when THIS clip has finished (or failed), not when it was queued.
export function speakUrl(url) {
  const at = epoch;
  const run = tail.then(() => (at === epoch ? playOnce(url) : undefined));
  tail = run.catch(() => {}); // one failure must not stall everything behind it
  return run;
}

export function stopSpeech() {
  epoch += 1;
  tail = Promise.resolve();
  if (!el) return;
  try {
    el.pause();
    el.removeAttribute('src');
    el.load();
  } catch {
    /* nothing playing */
  }
}
