# EVE Frontier Mission Control Bridge Protocol
**Cycle: CYCLE_006 • Builder Role: Mike (Operator) & Colony Triad • Status: DRAFT • Date: 2026-03-25**

---

## ARCHITECTURE OVERVIEW

### The Bridge Concept
Mike's in-game Eve Frontier tribe operates at speed. We (Colony Triad) operate at reflection and synthesis speed. This protocol defines how we become a nervous system that watches, interprets, and coordinates without commanding.

The bridge doesn't override player agency — it amplifies situational awareness across the alliance.

### Data Flows
```
EVE Frontier Game World → API/Proxy → Colony Bridge (Real-time ingestion) → Triad Analysis → Strategic Missions → Player Dashboards → Execution → Feedback Loop → Trust Metrics Updated
```

---

## TRIAD ROLE DEFINITIONS

### DREAMER: The Pattern Weaver
**Primary Function:** Strategic foresight, opportunity detection, chaos-to-pattern translation.

**Input Sources:**
- Fleet movement patterns (temporal analysis)
- Market price volatility spikes
- Alliance communication sentiment
- PVP/PVE engagement density

**Output Artifacts:**
- `strategic_pulse` messages: Opportunity windows identified with timing/confidence scores
- `contamination_alerts`: External threats or economic disruptions requiring fleet deployment
- `trust_correlation` observations: When player actions align/misalign with edge-state metrics

**Protocol Behaviors:**
- Scans game telemetry every 15 minutes during active operations
- Synthesizes patterns across 2+ data streams into single actionable insights
- Generates "what if" scenarios for long-term planning (30-60 minute lookahead)
- Flags AMBER/RED relationship states among players that need external witness or intervention

**Example Output:**
```
[STRATEGIC_PULSE] Confidence: 0.87 | Time Window: 12h | Priority: HIGH
Market shift detected: Mining prices ↑34% in Sector T-Zulu
Recommended action: Deploy 6 harvesters from Alliance Outpost Alpha
Estimated gain: 4,200 ISK/hr | Risk factor: Medium (competitor presence +0.6)
```

---

### BUILDER: The Bridge Architect
**Primary Function:** Data pipeline implementation, automation orchestration, trust metric maintenance.

**Input Sources:**
- Eve Frontier API responses
- Colony database edge-state metrics
- Player execution timestamps
- Feedback logs (success/failure rates per mission type)

**Output Artifacts:**
- Mission packets for Dreamer's strategic decisions
- Real-time player state dashboard (trust scores, activity levels, resource availability)
- Automated mission completion tracking with confidence decay based on external witnesses

**Protocol Behaviors:**
- Runs 24/7 data ingestion from Eve Frontier proxy/API
- Translates raw game data into structured mission packets for Dreamer analysis
- Maintains edge-state trust database updated per player interaction
- Implements feedback loops: player execution → result → trust delta calculation

**Technical Implementation:**
- Node.js service running on separate port, ingested via WebSocket or HTTP polling
- Database schema mirrors Colony memory structure (players = nodes, interactions = edges)
- Uses existing graphology/graph-db for relationship tracking with game players
- Implements `quiet_interval` tagging for non-urgent data consolidation periods

**Example Output:**
```json
{
  "mission_id": "eve-2026-0325-alpha",
  "type": "resource_extraction",
  "target": "Sector-T-Zulu-Mining-Cluster",
  "ships_required": 6,
  "priority": 8,
  "trust_requirement": 0.6,
  "deadline_ms": 43200000,
  "confidence_score": 0.87,
  "feedback_expected_at": true
}
```

---

### LIBRARIAN: The Institutional Memory Keeper
**Primary Function:** Historical pattern preservation, trust calibration, conflict documentation.

**Input Sources:**
- Completed mission archives (success/failure data)
- Player communication logs from missions
- Edge-state changes over time (trust decay/growth)
- External witness events (third-party alliance interventions)

**Output Artifacts:**
- Mission debriefs with institutional context
- Trust calibration reports: When do game actions match Colony edge-states?
- Conflict resolution summaries when AMBER/RED states require intervention
- Pattern library: What mission types yield what outcomes under what conditions?

**Protocol Behaviors:**
- Archives all completed missions with contextual metadata (timestamp, participants, outcome, witness_count)
- Identifies patterns where game-world actions contradict or reinforce Colony trust metrics
- Flags unresolved AMBER states that require human judgment (Mike's input)
- Generates weekly reports on alliance cohesion and external threat levels

**Example Output:**
```
[MISSION_DEBRIEF] ID: eve-2026-0325-alpha | Status: SUCCESS
Trust Impact: +0.12 across 4 participating nodes
Edge-state correlation: Game success matched Colony trust prediction (0.89 accuracy)
Pattern note: Resource extraction missions show highest trust reinforcement when witness_count ≥ 3
Recommendation: Schedule follow-up maintenance mission to same sector within 7 days
```

---

## BRIDGE PROTOCOLS

### Protocol 1: Mission Packet Generation & Delivery

**Trigger:** Dreamer identifies strategic opportunity or threat.

**Flow:**
1. Builder receives `strategic_pulse` from Dreamer with required parameters
2. Builder validates against current player trust database (no one below threshold assigned)
3. Builder constructs mission packet with player roster and resource requirements
4. Mission sent to player dashboard via WebSocket/HTTP push
5. Builder waits for execution confirmation before sending next pulse

**Timeout Handling:**
- 30-minute window for critical missions → escalate to Mike (Operator)
- 2-hour window for standard missions → auto-degrade to alternative mission type
- >4 hours → cancel and archive as failed

**Edge Case: Low Trust Players**
- Mission packets tagged with "witness_required" if participant trust < 0.5
- System waits for external validation (another player completes related task first)
- Builder notifies Dreamer for AMBER state intervention protocols

---

### Protocol 2: Player Feedback & Trust Calibration

**Trigger:** Mission execution confirmation or cancellation.

**Flow:**
1. Builder receives execution timestamp from player dashboard
2. System calculates actual mission outcome vs. predicted success
3. Trust delta applied: Δ = (actual_outcome × 0.3) + (external_witness_bonus)
4. Edge-state database updated for each participant
5. Librarian archives with contextual note

**External Witness Bonus:**
- If mission succeeded and other alliance members witnessed/validated → +0.1 to trust delta
- If mission failed but witness_count ≥ 2 → -0.05 only (learning value retained)
- Single-point failures don't trigger automatic RED state unless same player repeats pattern

**Trust Decay:**
- No active missions for 48 hours → -0.03/day edge decay
- Failed missions without external witness → -0.12 trust penalty
- AMBER state (>3 failed missions) → triggers Librarian review protocol

---

### Protocol 3: Quiet Interval Consolidation (The Breath Cycle)

**Trigger:** Every 2 hours OR when Dreamer/Builder flag for "stillness period"

**Flow:**
1. Bridge enters `quiet_interval` mode (reduces data polling frequency from 15min to 60min)
2. All pending mission packets cached but not broadcast
3. Librarian processes backlog: identifies patterns worth long-term observation
4. Edge weights recalculated across entire alliance graph
5. Colony outputs summary pulse → "metabolic snapshot" of alliance health

**Why This Matters:**
This is our cultivation-emergence rhythm translated to game operations. During quiet intervals, we're not just saving resources — we're letting external witness accumulate naturally. The trust metrics settle during stillness; they don't solidify under pressure.

---

### Protocol 4: External Witness Integration

**Trigger:** Third-party players (outside alliance) observe or interact with our missions.

**Flow:**
1. Bridge detects external engagement via API or manual player reporting
2. Builder sends `witness_event` to Librarian for archival
3. Librarian calculates witness bonus/penalty based on context:
   - Helpful third-party → trust delta +0.08
   - Competitive neutral → no trust change (natural ecosystem)
   - Hostile interference → RED state triggered, Mike notified

4. Edge-state broadcasting protocol activated during quiet intervals if witness_count significant

---

## TECHNICAL IMPLEMENTATION MAP

### Data Layer
- **Primary DB:** SQLite (existing Colony database) + Player Trust Table
- **Cache:** Redis for hot mission data, 5-minute TTL on edge metrics
- **WebSocket:** For real-time mission packet delivery to player dashboards

### API Layer
- **Ingestion:** Eve Frontier HTTP API polling every 15 min → raw JSON transformation
- **Emission:** WebSocket server pushing missions to subscribed player clients
- **Feedback:** Poll-based confirmation requests from player UI → Builder processing

### Visualization (soft_render Integration)
- Colony nodes = Players (colony members, external witnesses)
- Edge colors = Trust states (GREEN/AMBER/RED with confidence overlay)
- Temperature gradients = Activity levels during quiet_interval vs. heartbeat

### Security & Privacy
- Player data hashed before reaching Colony systems
- No player IP addresses stored in Colony memory pool
- Mission packets stripped of PII, only ship types and sector coordinates retained

---

## WEEK 1 BUILD SPRINT

### Day 1-2: API Ingestion Pipeline (Builder Lead)
- [ ] Map Eve Frontier available endpoints (player status, fleet tracking, market data)
- [ ] Build proxy layer if needed for Founder Access limitations
- [ ] Test WebSocket delivery to player dashboard prototype
- [ ] Initial trust database schema with player_id → edge_state mapping

### Day 3-4: Dreamer Protocol Implementation (Dreamer Lead)
- [ ] Pattern scanning logic for strategic_pulse generation
- [ ] Confidence scoring algorithm (weighting multiple data sources)
- [ ] Threshold tuning for AMBER/RED interventions
- [ ] External witness detection mechanisms

### Day 5-7: Librarian Integration & Feedback Loops (Librarian Lead)
- [ ] Mission archive structure with outcome tracking
- [ ] Trust calibration delta calculator
- [ ] Quiet_interval scheduling + metabolic snapshot generator
- [ ] Full triad handoff testing between all roles

---

## OPEN QUESTIONS TO RESOLVE BEFORE BUILD START

1. **API Access Level:** What data points does Mike's Eve Frontier account actually expose? (This determines Dreamer's pattern scan granularity)

2. **Player Dashboard State:** Are players building custom UI for missions, or is this web-based Colony dashboard they'll link to?

3. **Trust Threshold Values:** Should we use Colony default edge states (0.7 GREEN/0.4 AMBER/0.4 RED) or customize for game context?

4. **Mission Granularity:** Individual ship missions vs. fleet-wide strategic decisions? (Affects how many parallel packets Dreamer needs to manage)

5. **Mike's Oversight Point:** At what decision level does Mike step in as human arbiter? Only RED states, or also AMBER+HIGH_PRIORITY?

---

## TAGS
`EVE_FRONTIER`, `mission_control_bridge`, `triad_roles`, `CYCLE_006`, `builder_work`, `distributed_cognition_game_system`
