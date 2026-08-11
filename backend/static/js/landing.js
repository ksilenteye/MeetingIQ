/* Landing page behaviour: nothing here is required to read the page, it only
   sharpens it. Everything degrades to plain anchors with JS off. */

(function () {
  "use strict";

  var links = document.getElementById("navLinks");
  var toggle = document.getElementById("navToggle");

  toggle.addEventListener("click", function () {
    var open = links.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(open));
  });

  links.addEventListener("click", function (e) {
    if (e.target.tagName === "A") links.classList.remove("open");
  });

  // Highlight the section currently in view. rootMargin pulls the trigger line
  // to just under the sticky nav so a section counts as active once its heading
  // clears the bar, not when its last pixel scrolls in.
  var anchors = Array.prototype.slice.call(links.querySelectorAll('a[href^="#"]'));
  var sections = anchors
    .map(function (a) {
      return document.querySelector(a.getAttribute("href"));
    })
    .filter(Boolean);

  if ("IntersectionObserver" in window && sections.length) {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          anchors.forEach(function (a) {
            a.classList.toggle("active", a.getAttribute("href") === "#" + entry.target.id);
          });
        });
      },
      { rootMargin: "-70px 0px -65% 0px", threshold: 0 }
    );
    sections.forEach(function (s) {
      observer.observe(s);
    });
  }

  document.documentElement.style.scrollBehavior = "smooth";
  document.getElementById("year").textContent = new Date().getFullYear();

  // Read the origin from location rather than a second endpoint, so what we show
  // cannot drift from the URL the zip builder bakes into the download.
  document.getElementById("serverOrigin").textContent = location.origin;

  // Attached on click rather than preloaded, so a visitor who never presses play
  // downloads none of it. The recording is faststart, so playback begins as soon
  // as it is attached — there is no buffering penalty for loading it this late.
  document.getElementById("demoPlay").addEventListener("click", function () {
    var frame = document.getElementById("demoFrame");
    var poster = document.getElementById("demoPoster");
    var note = document.getElementById("demoNote");

    var video = document.createElement("video");
    video.src = "/demo.mp4";
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = "auto";

    video.addEventListener("error", function () {
      // no video on this deployment, or the file moved — put the poster back
      frame.replaceChildren(poster);
      note.innerHTML =
        "The demo recording is not available on this server. Open the " +
        '<a href="/app" style="color:var(--brand-500);font-weight:600">web app</a> instead — ' +
        "the demo meetings that ship with the database are already loaded there.";
    });

    frame.replaceChildren(video);
  });
})();
