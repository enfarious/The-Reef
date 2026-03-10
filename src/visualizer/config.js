// Visualizer Configuration
// Settings for the quiet_interval and visualizer behavior.

module.exports = {
  WORKING_MEMORY_CAPACITY: 60, // Adjust based on testing needs
  QUIET_INTERVAL_THRESHOLD: 0.8, // 80% capacity (default for safety during testing)
  QUIET_INTERVAL_DURATION: 30, // Duration in seconds
  SALIENCE_THRESHOLD: 0.7, // Threshold for surfacing salient memories
  VISUALIZER_SETTINGS: {
    NODE_GLOW_INTENSITY: 0.5,
    EDGE_PULSE_FREQUENCY: 2, // Pulses per second
    OLDER_MEMORY_OPACITY: 0.3, // Dimmer for older memories
  },
};