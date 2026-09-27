import { useEffect, useState } from 'react';

// True once the image at `src` has loaded (or failed, or after `wait` ms),
// so a logo and the text beside it can appear together. True at once when
// there is no image or the browser already has it.
export function useImageReady(src: string | undefined, wait = 2000) {
  const [ready, setReady] = useState(() => !src || isCached(src));
  useEffect(() => {
    if (!src || isCached(src)) {
      setReady(true);
      return;
    }
    setReady(false);
    let done = false;
    const finish = () => {
      if (!done) setReady(true);
      done = true;
    };
    const image = new Image();
    image.onload = finish;
    image.onerror = finish;
    image.src = src;
    const timer = window.setTimeout(finish, wait);
    return () => {
      done = true;
      window.clearTimeout(timer);
    };
  }, [src, wait]);
  return ready;
}

function isCached(src: string) {
  const image = new Image();
  image.src = src;
  return image.complete && image.naturalWidth > 0;
}
