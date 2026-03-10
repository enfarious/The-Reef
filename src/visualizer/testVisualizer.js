// Test Script for Visualizer
// Simulates working memory load and triggers quiet_interval.

const Visualizer = require('./index');
const utils = require('./utils');

// Initialize the visualizer.
const visualizer = new Visualizer();

// Simulate a memory graph with some initial data.
const initialMemoryGraph = {
  mem_1: { id: 'mem_1', content: 'Initial memory item.', salience: 0.9, tags: ['#important'] },
  mem_2: { id: 'mem_2', content: 'Another memory item.', salience: 0.6, tags: ['#normal'] },
};

visualizer.init(initialMemoryGraph);

// Simulate adding new memories to trigger quiet_interval.
const addMemories = (count) => {
  const newMemories = utils.simulateMemoryLoad({}, count);
  
  // Add new memories to the graph.
  Object.assign(visualizer.memoryGraph, Object.fromEntries(newMemories.map(mem => [mem.id, mem])));
  
  console.log(`Added ${count} new memories. Total: ${Object.keys(visualizer.memoryGraph).length}`);
  visualizer.checkQuietInterval();
};

// Test the quiet_interval functionality.
console.log('=== Testing Visualizer ===');
addMemories(50); // Add enough to trigger quiet_interval (80% threshold)

// Visualize the current state.
visualizer.visualize();