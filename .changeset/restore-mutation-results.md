---
"@openuidev/lang-core": patch
"@openuidev/react-lang": patch
---

Allow hosts to restore or mirror mutation results without executing tools, using `QueryManager.setMutationResult`, `createQueryManager`'s `onMutationResult` option, and the Renderer `mutationResults` and `onMutationResult` props. Preserve result ownership across registration and lifecycle changes, allow retry after restoring loading, and ignore unchanged supplied values so they never replay over newer local results.
