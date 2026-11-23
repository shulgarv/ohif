  (0,react.useEffect)(() => {
    commandsManager.registerCommand('DEFAULT', 'localClearAllMeasurements', {
      commandFn: () => {
        if (!measurementService.getMeasurements().length) return;
        // Read the live machine state, including when the Measurements panel
        // has never been opened. Preserve tracking metadata for Undo/Redo.
        const {trackedStudy, trackedSeries} = trackedMeasurements.context;
        const trackingContext = trackedStudy ? {
          StudyInstanceUID: trackedStudy,
          SeriesInstanceUIDs: [...trackedSeries]
        } : undefined;
        measurementService.clearMeasurements(undefined, trackingContext ? {trackingContext} : undefined);
        measurementService.setIsMeasurementDeletedIndividually(false);
        sendTrackedMeasurementsEvent('CLEAR_TRACKING_CONTEXT');
      }
    });
    return () => {
      delete commandsManager.getContext('DEFAULT').localClearAllMeasurements;
    };
  }, [commandsManager, measurementService, sendTrackedMeasurementsEvent, trackedMeasurements]);
