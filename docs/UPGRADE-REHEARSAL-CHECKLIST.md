# Money Map upgrade rehearsal checklist

This checklist uses only the Git-tracked synthetic fixture. It does not inspect a Production profile, contact Plaid, deploy a Worker, or install a Production executable.

1. Confirm the worktree contains no generated database or backup files with `git status --short`.
2. Run `node .\scripts\validate-upgrade-rehearsal-fixture.mjs`.
3. Run `.\scripts\check-rehearsal-build.ps1`. It validates source isolation, builds and scans the rehearsal executable for forbidden hosts/capabilities, runs its tests, checks Production and Sandbox independently, and confirms invalid feature combinations fail closed.
4. Verify the rehearsal tests cover encrypted generation, absent provider authority, migration rollback/idempotence, backup/restore, wrong-key and wrong-profile rejection, all synthetic recovery states, and reset gating.
5. Do not run `--generate` during CI. A deliberate local rehearsal may run it once; generated runtime data stays under the rehearsal application identity and remains untracked.
