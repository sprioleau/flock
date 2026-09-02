# Session handoffs

Before starting continuation work, look in `/Users/temiloluwaprioleau/Desktop/🫴 Handoffs/` for the most recently modified `*-next-agent-prompt_*.md`. Read that prompt first, then read any full handoff document it references end to end. Treat the selected next-agent prompt as the delegated prompt for the session unless the user's current request overrides it.

# Verification and delivery

Always run the relevant test suites and confirm the linter passes. For substantial features, open the app in a browser, exercise the complete user-facing flow, and verify it behaves according to the owner's requirements. For any Convex schema change, run `convex deploy` successfully before committing and pushing; that deploy triggers the Vercel deployment. As soon as a feature set passes its automated and browser verification, commit and push it so continuous deployment can begin before starting the next feature set.

# Project memory

Project documentation is currently git-ignored and stored in `/Users/temiloluwaprioleau/dev/flock/docs`. Use that directory for decisions, feature ideas, and other project knowledge that should persist beyond a session, except for next-agent handoffs, which stay in the desktop handoff directory documented above. When the owner asks what to build next, inspect the project docs and resurface relevant unbuilt ideas captured by previous session agents.

# Communication

Respond to the owner in a straight-to-the-point manner. Include enough context to support decisions about direction, but omit highly detailed explanations unless the owner explicitly asks for them.

# Orchestration

Keep the main agent's context lean by acting as an orchestrator. For each substantial task, dispatch bounded exploration or implementation slices to parallel subagents whenever possible, using the Luna model for subagents when supported. Give every subagent an explicit file fence, required verification and failing-first/negative tests, and a no-git-mutation rule. Reconcile and personally review the results in the main agent before integrating, committing, or pushing.
