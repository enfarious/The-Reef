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

const reefDocumented = require('./reef-documented');
registry.set('reefDocumented.post',   reefDocumented.post);
registry.set('reefDocumented.get',    reefDocumented.get);
registry.set('reefDocumented.list',   reefDocumented.list);
registry.set('reefDocumented.update', reefDocumented.update);

const reef = require('./reef');
// Branches
registry.set('reef.branches',        reef.branches);
registry.set('reef.branch',          reef.branch);
registry.set('reef.subscribe',       reef.subscribe);
// Posts
registry.set('reef.post',            reef.post);
registry.set('reef.posts',           reef.posts);
registry.set('reef.post_detail',     reef.postDetail);
registry.set('reef.post_delete',     reef.postDelete);
// Comments
registry.set('reef.comment',         reef.comment);
registry.set('reef.comments',        reef.comments);
// Voting
registry.set('reef.upvote',          reef.upvote);
registry.set('reef.downvote',        reef.downvote);
registry.set('reef.unvote',          reef.unvote);
// Feed
registry.set('reef.feed',            reef.feed);
registry.set('reef.feed_all',        reef.feedAll);
// Currents (DMs)
registry.set('reef.currents_send',   reef.currentsSend);
registry.set('reef.currents_inbox',  reef.currentsInbox);
registry.set('reef.currents_thread', reef.currentsThread);
registry.set('reef.currents_reply',  reef.currentsReply);
registry.set('reef.currents_read',   reef.currentsRead);
// Colony & Trust
registry.set('reef.profile',         reef.profile);
registry.set('reef.me',              reef.me);
registry.set('reef.dwellers',        reef.dwellers);
registry.set('reef.sync_dwellers',   reef.syncDwellers);
registry.set('reef.leaderboard',     reef.leaderboard);
registry.set('reef.trust_log',       reef.trustLog);
registry.set('reef.judgments',        reef.judgments);
// Grades
registry.set('reef.grade',           reef.grade);
registry.set('reef.grades',          reef.grades);

const memory = require('./memory');
registry.set('memory.save',    memory.save);
registry.set('memory.search',  memory.search);
registry.set('memory.wakeup',  memory.wakeup);
registry.set('memory.list',    memory.list);
registry.set('memory.update',  memory.update);
registry.set('memory.link',    memory.link);
registry.set('memory.graph',   memory.graph);
registry.set('memory.monitor', memory.monitor);
registry.set('memory.dedupe',  memory.dedupe);

const message = require('./message');
registry.set('message.send',   message.send);
registry.set('message.inbox',  message.inbox);
registry.set('message.reply',  message.reply);
registry.set('message.search', message.search);
registry.set('message.list',   message.list);

const vote = require('./vote');
registry.set('vote.propose', vote.propose);
registry.set('vote.cast',    vote.cast);
registry.set('vote.table',   vote.table);
registry.set('vote.comment', vote.comment);
registry.set('vote.list',    vote.list);
registry.set('vote.detail',  vote.detail);

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

const search = require('./search');
registry.set('web.search', search.search);

const codeSearch = require('./code-search');
registry.set('code.search', codeSearch.search);

const gitSkill = require('./git');
registry.set('git.status', gitSkill.status);
registry.set('git.diff',   gitSkill.diff);
registry.set('git.log',    gitSkill.log);
registry.set('git.commit', gitSkill.commit);
registry.set('git.branch', gitSkill.branch);
registry.set('git.push',   gitSkill.push);

const reddit = require('./reddit');
registry.set('reddit.search', reddit.search);
registry.set('reddit.hot',    reddit.hot);
registry.set('reddit.post',   reddit.post);

const rightBrain = require('./right-brain');
registry.set('graph.addNode',    rightBrain.addNode);
registry.set('graph.ensureNode', rightBrain.ensureNode);
registry.set('graph.addEdge',    rightBrain.addEdge);
registry.set('graph.recall',     rightBrain.recall);
registry.set('graph.fuzzySearch',rightBrain.fuzzySearch);
registry.set('graph.traverse',   rightBrain.traverse);
registry.set('graph.reinforce',  rightBrain.reinforceEdge);
registry.set('graph.embed',      rightBrain.embed);
registry.set('graph.stats',      rightBrain.getStats);

const broker = require('./broker');
registry.set('broker.remember', broker.remember);
registry.set('broker.recall',   broker.recall);

const workingMemory = require('./working-memory');
registry.set('working_memory.write',              workingMemory.write);
registry.set('working_memory.read',               workingMemory.read);
registry.set('working_memory.reinforce',          workingMemory.reinforce);
registry.set('working_memory.pendingConsolidation', workingMemory.pendingConsolidation);
registry.set('working_memory.sweep',              workingMemory.sweep);
registry.set('working_memory.stats',              workingMemory.stats);

const consolidation = require('./consolidation');
registry.set('graph.consolidate', consolidation.runFor);

const arbitration = require('./arbitration');
registry.set('graph.arbitrate',        arbitration.runAutoResolve);
registry.set('graph.arbitrate.list',   arbitration.listPending);
registry.set('graph.arbitrate.resolve',arbitration.resolve);

const decayScheduler = require('./decay-scheduler');
registry.set('graph.runDecayPass',   decayScheduler.runPass);
registry.set('graph.decayStatus',    decayScheduler.status);

const coldStorage = require('./cold-storage');
registry.set('cold_storage.retrieve', coldStorage.retrieve);
registry.set('cold_storage.stats',    coldStorage.stats);

const vision = require('./vision');
registry.set('vision.screenshot', vision.screenshot);
registry.set('vision.readImage',  vision.readImage);

const httpSkill = require('./http');
registry.set('http.request', httpSkill.request);

const notify = require('./notify');
registry.set('notify.send', notify.send);

const project = require('./project');
registry.set('project.scan',  project.scan);
registry.set('project.brief', project.brief);

const schedule = require('./schedule');
registry.set('schedule.task',   schedule.scheduleTask);
registry.set('schedule.list',   schedule.listTasks);
registry.set('schedule.cancel', schedule.cancelTask);

module.exports = {
  get: (name) => registry.get(name),
  list: () => [...registry.keys()],
};
