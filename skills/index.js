'use strict';

const config = require('./config');
const llm = require('./llm');

// Skill registry — maps skill names to async handler functions.
// Each handler receives (args, ctx) where ctx = { mainWindow }.
const registry = new Map();

registry.set('ping', async (_args) => 'pong');

registry.set('config.save', config.save);
registry.set('config.load', config.load);

registry.set('llm.complete', llm.complete);
registry.set('llm.models',  llm.fetchModels);

const reef = require('./reef');
registry.set('reef.post',   reef.post);
registry.set('reef.get',    reef.get);
registry.set('reef.list',   reef.list);
registry.set('reef.update', reef.update);

const memory = require('./memory');
registry.set('memory.save',   memory.save);
registry.set('memory.search', memory.search);
registry.set('memory.wakeup', memory.wakeup);
registry.set('memory.list',   memory.list);
registry.set('memory.update', memory.update);
registry.set('memory.link',   memory.link);

const message = require('./message');
registry.set('message.send',   message.send);
registry.set('message.inbox',  message.inbox);
registry.set('message.reply',  message.reply);
registry.set('message.search', message.search);
registry.set('message.list',   message.list);

const filesystem = require('./filesystem');
registry.set('fs.read',     filesystem.read);
registry.set('fs.write',    filesystem.write);
registry.set('fs.delete',   filesystem.remove);
registry.set('fs.list',     filesystem.list);
registry.set('fs.exists',   filesystem.exists);
registry.set('fs.pickFile', filesystem.pickFile);
registry.set('fs.pickDir',  filesystem.pickDir);

const shell = require('./shell');
registry.set('shell.run', shell.run);

const clipboard = require('./clipboard');
registry.set('clipboard.read',  clipboard.read);
registry.set('clipboard.write', clipboard.write);

module.exports = {
  get: (name) => registry.get(name),
  list: () => [...registry.keys()],
};
