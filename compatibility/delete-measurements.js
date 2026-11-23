  const onDelete = () => {
    // Measurements can exist while the tracking machine is idle/off, where
    // UNTRACK_ALL is ignored. Clear the service directly in every state.
    const trackingContext = trackedStudy ? {
      StudyInstanceUID: trackedStudy,
      SeriesInstanceUIDs: [...trackedSeries]
    } : undefined;
    measurementService.clearMeasurements(undefined, trackingContext ? {trackingContext} : undefined);
    measurementService.setIsMeasurementDeletedIndividually(false);
    // The existing history memo restores/clears tracking on undo/redo.
    sendTrackedMeasurementsEvent('CLEAR_TRACKING_CONTEXT');
  };
