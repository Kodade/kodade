# Logic prototype

Use this shape when the uncertainty is about business rules, transitions, or data representation—especially when the model looks fine on paper but needs to be exercised with real sequences.

## Good questions for this shape

- Does a state machine handle an awkward sequence of events?
- Can the data model represent a specific edge case?
- What should the API surface feel like before implementation?
- What happens when a person drives the model one action at a time?

If the question is about appearance or interaction layout, use [UI.md](UI.md) instead.

## Process

### 1. Write down the question

Before coding, state the state model under examination and the decision the experiment should settle. Put that statement in the prototype README or at the top of the main file so it remains clear when someone returns later.

### 2. Follow the host project

Use the language, runtime, package manager, and task conventions already present. If the project has no obvious runtime, ask before choosing one. Do not add a new ecosystem just for a disposable experiment.

### 3. Keep the logic portable

Put the part being evaluated behind a small, pure interface that could be lifted into the real code later. Choose the simplest fitting form:

- a reducer for discrete actions over a state value;
- an explicit state machine when legal transitions matter;
- pure functions over plain data when there is no implicit current state;
- a small state-owning module or class only when ongoing internal state is itself part of the question.

Keep terminal I/O out of this module. The interactive shell calls the logic; the logic does not know about prompts, escape codes, or logging.

### 4. Expose the whole state

Build a minimal terminal UI. On every input, clear and redraw one complete frame rather than adding to scrollback. Show the full relevant state first, then the available keyboard shortcuts. Use simple formatting—bold labels and dim supporting detail are enough.

The loop should:

1. create one in-memory state value;
2. render the initial frame;
3. read one key or line at a time;
4. dispatch it through a handler;
5. render the complete frame again;
6. stop on the quit action.

Keep the frame short enough to fit on one screen.

### 5. Make the command obvious

Add a script to the existing task runner, such as `pnpm run <name>`, `make <name>`, or the project's equivalent. If no runner exists, put the exact command at the top of the prototype README.

### 6. Hand it over

Give the user the run command and let them drive the cases. Treat reactions such as “that should not be possible” as evidence about the design. Add actions only when they help answer the same question.

### 7. Capture the result

Record the answer and the validated reducer, machine, or function boundary. Keep the terminal shell on the throwaway branch; only the proven logic and decision belong in the real implementation.

## Avoid

- Adding tests or production-grade recovery to a short-lived experiment.
- Connecting to the real database when an in-memory store can answer the question.
- Designing for hypothetical future features.
- Mixing prompts, terminal rendering, or `console.log` control flow into the logic module.
- Promoting the TUI directly into production.
