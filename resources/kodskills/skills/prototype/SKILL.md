---
name: prototype
description: "The prototype skill builds clearly throwaway code to answer a concrete design question about logic, state, data shape, or UI. Use it when runnable evidence will settle a design choice faster than more discussion."
---

# Prototype

A prototype is a short-lived experiment with one job: answer a design question. Start with the question, then choose the smallest artifact that can produce useful evidence.

## Choose the shape

Name the question from the user's request, nearby code, or a short clarification:

- **Logic, state, or data model** — read [LOGIC.md](LOGIC.md). Build a tiny interactive terminal experiment that drives the hard cases by hand.
- **Visual or interaction design** — read [UI.md](UI.md). Put several genuinely different variants on one route and let the user switch between them.

If the request is ambiguous and the user is unavailable, follow the surrounding code: backend or domain module usually means logic; a page or component usually means UI. State that assumption in the prototype.

## Rules for every prototype

1. Mark it as throwaway immediately. Keep it near the module or page under examination, use the host project's routing conventions, and name it so nobody mistakes it for production code.
2. Give it one obvious run command using the project's existing task runner. Do not make the user remember a path.
3. Keep state in memory unless persistence is the question. If persistence is under test, use a clearly disposable scratch database or file.
4. Optimize for learning, not polish. Skip tests, broad error handling, and abstractions that do not help the experiment run.
5. Make the relevant state visible after each logic action or variant change.
6. When the question is settled, fold the validated decision into production code. Preserve the experiment on a throwaway branch as a primary source, and record the verdict plus a pointer to that branch on the implementation issue. Use GitHub Issues through `gh` by default; if there is no GitHub remote or authentication, use one markdown ticket under `.scratch/<effort>/issues/`.

Do not report the prototype as the finished implementation. The experiment is evidence; the production version needs its own appropriate design, tests, and error handling.
