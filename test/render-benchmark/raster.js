// Use the production controller's configuration API, not a clock/readiness stub.
export function pinRaster(renderer) {
  const ratio = renderer.ratioCap;
  renderer.scaleController.reset({ minRatio: ratio, maxRatio: ratio, pixelRatio: ratio });
  if (renderer.renderer.getPixelRatio() !== ratio) renderer.renderer.setPixelRatio(ratio);
}

export function rasterState(renderer) {
  return { pixelRatio: renderer.renderer.getPixelRatio(),
    width: renderer.renderer.domElement.width, height: renderer.renderer.domElement.height };
}

export function fixedRasterEvidence(run) {
  const expected = run.settings?.fixedRaster;
  return run.settings?.rasterPolicy === "fixed-quality-cap" &&
    expected?.width > 0 && expected?.height > 0 && expected?.pixelRatio > 0 &&
    run.samples?.length > 0 && run.samples.every(s => s.raster?.width === expected.width &&
      s.raster?.height === expected.height && s.raster?.pixelRatio === expected.pixelRatio) &&
    run.machine?.drawingBuffer?.[0] === expected.width && run.machine?.drawingBuffer?.[1] === expected.height &&
    run.machine?.pixelRatio === expected.pixelRatio;
}
