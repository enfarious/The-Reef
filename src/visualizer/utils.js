// Visualizer Utilities
// Helper functions for the visualizer module.

module.exports = {
  // Simulate working memory load (for testing).
  simulateMemoryLoad: (memoryGraph, count) => {
    const newMemories = [];
    
    for (let i = 0; i < count; i++) {
      const id = `mem_${Date.now()}_${i}`;
      const memoryItem = {
        id,
        content: `Memory item ${i} - ${new Date().toISOString()}`.substring(11, 23),
        salience: Math.random(), // Random salience for simulation
        tags: [`#memory_${Math.floor(Math.random() * 5)}`],
      };
      newMemories.push(memoryItem);
    }
    
    return newMemories;
  },
  
  // Log memory graph state for debugging.
  logMemoryGraph: (memoryGraph) => {
    console.log('Memory Graph State:');
    Object.entries(memoryGraph).forEach(([id, item]) => {
      console.log(`- ${id}:`, item.content, `Salience: ${item.salience}`);
    });
  },
};