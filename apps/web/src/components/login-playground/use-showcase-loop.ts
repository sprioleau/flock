"use client";

import { useEffect, useState } from "react";
import { SHOWCASE_BEATS, getShowcaseSceneState } from "./showcase-scene";

export function useShowcaseLoop() {
  const [beatIndex, setBeatIndex] = useState(0);
  const [restartCount, setRestartCount] = useState(0);
  const [isPageVisible, setIsPageVisible] = useState(true);
  const [isReducedMotion, setIsReducedMotion] = useState(false);

  useEffect(() => {
    function updatePageVisibility(): void {
      setIsPageVisible(document.visibilityState === "visible");
    }
    updatePageVisibility();
    document.addEventListener("visibilitychange", updatePageVisibility);
    return () => document.removeEventListener("visibilitychange", updatePageVisibility);
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    function updateMotionPreference(): void {
      setIsReducedMotion(mediaQuery.matches);
    }
    updateMotionPreference();
    mediaQuery.addEventListener("change", updateMotionPreference);
    return () => mediaQuery.removeEventListener("change", updateMotionPreference);
  }, []);

  useEffect(() => {
    if (!isPageVisible || isReducedMotion) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setBeatIndex((currentIndex) => (currentIndex + 1) % SHOWCASE_BEATS.length);
    }, SHOWCASE_BEATS[beatIndex]!.durationMs);
    return () => window.clearTimeout(timeoutId);
  }, [beatIndex, isPageVisible, isReducedMotion, restartCount]);

  function restartShowcase(): void {
    setBeatIndex(0);
    setRestartCount((currentCount) => currentCount + 1);
  }

  return {
    scene: getShowcaseSceneState({ beatIndex, isReducedMotion }),
    isReducedMotion,
    restartShowcase,
  };
}
