/* Detect which deployment this build is running on. */
(function () {
  var host = location.hostname;
  var path = location.pathname;
  var mode = 'public';
  if (/orlando-code\.github\.io$/i.test(host)) {
    if (/^\/icrs2026-staging(?:\/|$)/.test(path)) mode = 'staging';
    else if (/^\/icrs2026(?:\/|$)/.test(path)) mode = 'personal';
  } else if (/nirivas\.github\.io$/i.test(host)) {
    mode = 'nico';
  }
  window.ICRS_SITE_MODE = mode;
})();
