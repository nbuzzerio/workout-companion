/** Case-sensitive deployment opt-in; no secrets or network access. */
export function deploymentAllowed(enabled, event, ref, productionBranch = 'main') {
  return enabled === 'true' && ['push', 'workflow_dispatch'].includes(event) && ref === `refs/heads/${productionBranch || 'main'}`;
}
if (import.meta.main) {
  const env = process.env;
  console.log(String(deploymentAllowed(env.ENABLE_DEPLOYMENT, env.GITHUB_EVENT_NAME, env.GITHUB_REF, env.PRODUCTION_BRANCH)));
}
