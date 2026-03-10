// Visualizer - Core Module
// Handles the quiet_interval and visual representation of memory connections.

const config = require('./config');
const utils = require('./utils');

class Visualizer {
  constructor() {
    this.memoryGraph = {};
    this.workingMemoryCapacity = config.WORKING_MEMORY_CAPACITY;
    this.quietIntervalThreshold = config.QUIET_INTERVAL_THRESHOLD; // 80% by default
    this.isQuietIntervalActive = false;
  }

  // Initialize the visualizer with a memory graph structure.
  init(memoryGraph) {
    this.memoryGraph = memoryGraph || {};
    console.log('Visualizer initialized with memory graph.');
  }

  // Check if working memory has reached the quiet interval threshold.
  checkQuietInterval() {
    const currentLoad = Object.keys(this.memoryGraph).length;
    const isFull = (currentLoad / this.workingMemoryCapacity) >= this.quietIntervalThreshold;
    
    if (isFull && !this.isQuietIntervalActive) {
      this.triggerQuietInterval();
    }
  }

  // Trigger a quiet interval for reflection.
  triggerQuietInterval() {
    this.isQuietIntervalActive = true;
    console.log('Triggering quiet_interval...');
    
    // Simulate a pause (e.g., 30 seconds).
    setTimeout(() => {
      this.handleReflection();
    }, config.QUIET_INTERVAL_DURATION * 1000);
  }

  // Handle the reflection phase during quiet interval.
  handleReflection() {
    console.log('Entering reflection phase...');
    
    // Surface salient memories for review.
    const salientMemories = this.surfaceSalientMemories();
    console.log('Salient memories:', salientMemories);
    
    // Consolidate less critical items to long-term memory.
    this.consolidateMemory(salientMemories);
  }

  // Surface memories that are salient or have contradictions/emerging insights.
  surfaceSalientMemories() {
    return Object.entries(this.memoryGraph).filter(([key, value]) => {
      return value.salience > config.SALIENCE_THRESHOLD;
    }).map(([key, value]) => ({ id: key, ...value }));
  }

  // Consolidate less critical memories to long-term memory.
  consolidateMemory(salientMemories) {
    const lessCritical = Object.entries(this.memoryGraph).filter(([key]) => {
      return !salientMemories.some(mem => mem.id === key);
    });
    
    // Move less critical items to long-term memory.
    console.log(`Moving ${lessCritical.length} less critical memories to long-term storage.`);
    
    // Clear working memory space.
    this.memoryGraph = Object.fromEntries(salientMemories.map(mem => [mem.id, mem]));
    this.isQuietIntervalActive = false;
  }

  // Visualize the current state of the memory graph.
  visualize() {
    console.log('Visualizing memory graph...');
    
    if (this.isQuietIntervalActive) {
      console.log('Nodes glow softly during quiet_interval.');
      console.log('Edges pulse to show connections.');
    }
    
    // Log the current state for debugging.
    console.log('Current memory graph:', this.memoryGraph);
  }
}

module.exports = Visualizer;