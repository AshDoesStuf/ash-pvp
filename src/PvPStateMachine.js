const INTERRUPTORS = new Set(["EATING", "PEARLING"]);

class PvPStateMachine {
  /** @param {import("./pvp.js")} ashPvP */
  constructor(ashPvP) {
    this.ashPvP = ashPvP;
    this.bot = ashPvP.bot;
    this.states = new Map();
    this.current = null;

    this.#resumeStack = [];
    this.#debug = true;

    // FIX: tick lock prevents re-entrant tick calls from racing
    this.#ticking = false;
  }

  #resumeStack = [];
  #debug = false;
  #ticking = false;

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  registerState(name, stateInstance) {
    stateInstance.fsm = this;
    stateInstance.ashPvP = this.ashPvP;
    stateInstance.bot = this.bot;
    this.states.set(name, stateInstance);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(initialState = "IDLE") {
    await this.#enterState(initialState);
  }

  async stop() {
    if (this.current) await this.states.get(this.current)?.onExit();
    this.current = null;
    this.#resumeStack = [];
    this.#ticking = false;
    this.bot.clearControlStates();
  }

  // ---------------------------------------------------------------------------
  // Tick
  // FIX: now truly async-safe — updateTick calls this with await,
  // and the #ticking lock stops a slow async state from being re-entered
  // before it finishes.
  // ---------------------------------------------------------------------------

  async tick(deltaTime) {
    if (!this.current) return;
    if (this.#ticking) return; // drop the tick rather than race
    this.#ticking = true;

    try {
      // Check interruptors before ticking current state
      const interrupt = this.#checkInterruptors();
      if (interrupt && interrupt !== this.current) {
        await this.#pushInterruptor(interrupt);
        return;
      }

      const state = this.states.get(this.current);
      if (!state) return;

      const next = await state.tick(deltaTime);

      if (next && next !== this.current) {
        if (next === "RESUME") await this.#popInterruptor();
        else await this.transition(next);
      }
    } catch (err) {
      console.error(`[FSM] Uncaught error in state "${this.current}":`, err);
      // Safe fallback — don't leave FSM frozen
      await this.transition("IDLE").catch(() => {});
    } finally {
      this.#ticking = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Transition
  // ---------------------------------------------------------------------------

  async transition(nextName, data = {}) {
    if (!this.states.has(nextName)) {
      console.error(`[FSM] Unknown state: "${nextName}"`);
      return;
    }

    if (this.#debug)
      console.log(`[FSM] ${this.current ?? "null"} → ${nextName}`);

    if (this.current) await this.states.get(this.current).onExit();
    await this.#enterState(nextName, data);
  }

  /**
   * Called externally (e.g. from ffaTick/semiFfaTick in pvp.js) to force
   * a transition when a target is acquired outside the FSM tick.
   * Safe to call even while a tick is in progress — will no-op if ticking.
   */
  async forceTransition(nextName, data = {}) {
    if (this.#ticking) return; // let the current tick finish naturally
    await this.transition(nextName, data);
  }

  // ---------------------------------------------------------------------------
  // Interruptors
  // ---------------------------------------------------------------------------

  #checkInterruptors() {
    const { bot, ashPvP } = this;
    const awareness = ashPvP.awareness;
    const health = bot.health;
    const target = ashPvP.target;

    // --- Pearl interruptor ---
    // Only pearl if: critically low, has pearls, AND awareness confirms it's
    // worth it (target isn't dying, DPS is actually dangerous).
    const hasPearl = bot.inventory
      .items()
      .some((i) => i.name === "ender_pearl");
    // Pearl fall damage is always at least 5hp (base ender pearl damage).
    // Scanning downward for a landing spot can add up to ~3 more (4 block drop).
    // So we need at least 10hp to safely pearl — giving headroom for worst case.
    const PEARL_MIN_SAFE_HEALTH = 10;
    const isEmergency = health <= PEARL_MIN_SAFE_HEALTH;
    if (
      hasPearl &&
      isEmergency &&
      this.current !== "PEARLING" &&
      awareness?.shouldPearl(bot, target, health, PEARL_MIN_SAFE_HEALTH) !==
        false
    )
      return "PEARLING";

    // --- Eat interruptor ---
    // Defer to CombatAwareness for the full decision tree:
    // respects absorption windows, regen cooldown, target health, distance.
    const hasGap = bot.inventory.slots.some((i) =>
      i?.name?.includes("golden_apple"),
    );
    if (
      hasGap &&
      this.current !== "EATING" &&
      !INTERRUPTORS.has(this.current) &&
      awareness
    ) {
      const decision = awareness.shouldEat(bot, target, health);
      if (decision === "EAT") return "EATING";
      // "WAIT" means conditions will be right soon — don't eat yet but don't skip
      // "SKIP" means don't eat at all right now
    } else if (
      // Fallback if awareness not available — original simple threshold
      hasGap &&
      health <= 15 &&
      this.current !== "EATING" &&
      !INTERRUPTORS.has(this.current) &&
      !awareness
    ) {
      return "EATING";
    }

    return null;
  }

  async #pushInterruptor(name) {
    if (this.#debug)
      console.log(`[FSM] Interruptor: ${name} (pausing ${this.current})`);
    if (this.current) {
      await this.states.get(this.current).onExit();
      this.#resumeStack.push(this.current);
    }
    await this.#enterState(name);
  }

  async #popInterruptor() {
    const resume = this.#resumeStack.pop() ?? "IDLE";
    if (this.#debug) console.log(`[FSM] Resuming: ${resume}`);
    if (this.current) await this.states.get(this.current).onExit();
    await this.#enterState(resume);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  async #enterState(name, data = {}) {
    this.current = name;
    const state = this.states.get(name);
    if (state) {
      try {
        await state.onEnter(data);
      } catch (err) {
        // FIX: onEnter failure no longer silently freezes the FSM
        console.error(`[FSM] onEnter failed for "${name}":`, err);
        if (name !== "IDLE") await this.#enterState("IDLE");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// BaseState
// ---------------------------------------------------------------------------

class BaseState {
  /** @type {PvPStateMachine} */ fsm = null;
  /** @type {import("./pvp.js")} */ ashPvP = null;
  /** @type {import("mineflayer").Bot} */ bot = null;

  async onEnter(_data = {}) {}
  async tick(_dt) {
    return null;
  }
  async onExit() {}
}

module.exports = { PvPStateMachine, BaseState };
