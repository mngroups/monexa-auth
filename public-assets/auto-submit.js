// The logout page submits itself: first-party apps get no confirmation step.
document.addEventListener("DOMContentLoaded", () => {
  document.forms[0]?.submit();
});
