/* ---------------------------------------------------------------------------
   MeetingIQ dashboard.

   Vanilla ES5-ish, no build step, matching the rest of the repo. Every number
   rendered here comes from an endpoint that counts rows — nothing is modelled or
   padded, so an empty database shows empty states rather than sample data.

   Transcript text is meeting content from an untrusted DOM, so it only ever
   reaches the page through esc() or textContent.
   --------------------------------------------------------------------------- */

(function () {
  "use strict";

  var $ = function (sel) {
    return document.querySelector(sel);
  };
  var $$ = function (sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  };

  var LS = {
    openai: "llm_key_openai",
    groq: "llm_key_groq",
    gemini: "llm_key_gemini",
    provider: "llm_provider_id",
    model: "llm_model_override",
    fallback: "llm_allow_fallback",
    rag: "llm_use_rag",
    meeting: "iq_active_meeting",
    done: "iq_done_action_items",
  };

  var state = {
    meetings: [],
    stats: {},
    activeMeeting: "",
    view: "dashboard",
    ws: null,
    keepAlive: null,
    unseen: 0,
    query: "",
    transcript: [], // {timestamp, speaker, text} for the active meeting
    done: new Set(JSON.parse(localStorage.getItem(LS.done) || "[]")),
  };

  /* ------------------------------------------------------------- helpers -- */

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function initials(name) {
    var parts = String(name || "?")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  // Stable per-speaker hue so the same person keeps the same avatar colour
  // across reloads and across panels.
  function hueOf(name) {
    var h = 0;
    var s = String(name || "");
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }

  function avatar(name, cls) {
    var hue = hueOf(name);
    return (
      '<span class="avatar ' +
      (cls || "") +
      '" style="background:linear-gradient(145deg,hsl(' +
      hue +
      ",70%,62%),hsl(" +
      ((hue + 40) % 360) +
      ',72%,44%))" title="' +
      esc(name) +
      '">' +
      esc(initials(name)) +
      "</span>"
    );
  }

  function fmtDuration(seconds) {
    var s = Number(seconds) || 0;
    if (s <= 0) return "—";
    if (s < 60) return s + " sec";
    var m = Math.round(s / 60);
    if (m < 60) return m + " min";
    var h = Math.floor(m / 60);
    return h + "h " + String(m % 60).padStart(2, "0") + "m";
  }

  function fmtHours(seconds) {
    var s = Number(seconds) || 0;
    if (s < 3600) return (s / 60).toFixed(s < 600 ? 1 : 0) + " min";
    return (s / 3600).toFixed(1) + " hrs";
  }

  function parseDate(value) {
    if (!value) return null;
    // SQLite's datetime('now') has no zone marker; treat it as UTC, which is
    // what it actually is, instead of letting the browser read it as local.
    var text = String(value);
    var d = new Date(/[TZ+]/.test(text) ? text : text.replace(" ", "T") + "Z");
    return isNaN(d.getTime()) ? null : d;
  }

  function fmtDateTime(value) {
    var d = parseDate(value);
    if (!d) return "—";
    return (
      d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
      " · " +
      d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    );
  }

  function fmtClock(value) {
    var d = parseDate(value);
    return d ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
  }

  function highlight(text, term) {
    var safe = esc(text);
    if (!term) return safe;
    var needle = esc(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return safe.replace(new RegExp(needle, "gi"), function (m) {
      return "<mark>" + m + "</mark>";
    });
  }

  function emptyState(message, hint) {
    return (
      '<div class="empty"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/>' +
      '<path d="M7 9h10M7 13h6"/></svg><div>' +
      esc(message) +
      "</div>" +
      (hint ? '<div class="tiny" style="margin-top:6px">' + hint + "</div>" : "") +
      "</div>"
    );
  }

  var toastTimer = null;
  function toast(message, isError) {
    var node = $("#toast");
    node.textContent = message;
    node.classList.toggle("err", !!isError);
    node.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      node.classList.remove("show");
    }, 3800);
  }

  function getJSON(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error(res.status + " " + res.statusText);
      return res.json();
    });
  }

  function postJSON(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      if (!res.ok) throw new Error(res.status + " " + res.statusText);
      return res.json();
    });
  }

  /* -------------------------------------------------------------- router -- */

  function setView(name) {
    if (!name) name = "dashboard";
    state.view = name;
    $$(".view").forEach(function (section) {
      section.hidden = section.getAttribute("data-view") !== name;
    });
    $$("#sideNav button").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-view") === name);
    });
    if (location.hash !== "#/" + name) history.replaceState(null, "", "#/" + name);
    document.querySelector(".content").scrollTop = 0;
    window.scrollTo({ top: 0, behavior: "auto" });

    if (name === "transcripts") {
      state.unseen = 0;
      renderBell();
      renderTranscript();
    }
    if (name === "insights") loadInsights();
    if (name === "actions") loadActionItems();
    if (name === "summaries") loadSummaries();
    if (name === "help") loadHealth();
    if (name === "settings") loadAssistantStatus();
  }

  /* ------------------------------------------------------------ rendering -- */

  function renderStats(stats) {
    state.stats = stats;
    var tiles = [
      {
        cls: "",
        label: "Total Meetings",
        value: stats.total_meetings,
        icon: '<rect x="2" y="6" width="13" height="12" rx="2"/><path d="M15 10l7-3v10l-7-3"/>',
      },
      {
        cls: "green",
        label: "Time Captured",
        value: fmtHours(stats.captured_seconds),
        icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      },
      {
        cls: "amber",
        label: "Transcript Lines",
        value: (stats.total_lines || 0).toLocaleString(),
        icon: '<path d="M4 5h16M4 10h10M4 15h13M4 20h7"/>',
      },
      {
        cls: "blue",
        label: "AI Runs",
        value: stats.ai_actions,
        icon: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/>',
      },
    ];

    $("#statGrid").innerHTML = tiles
      .map(function (t) {
        return (
          '<div class="stat"><span class="icon-tile ' +
          t.cls +
          '"><svg viewBox="0 0 24 24">' +
          t.icon +
          "</svg></span><div><b>" +
          esc(t.value) +
          "</b><span>" +
          esc(t.label) +
          "</span></div></div>"
        );
      })
      .join("");

    $("#dashSub").textContent =
      stats.total_meetings === 0
        ? "No meetings captured yet — install the extension and turn on live captions."
        : stats.total_meetings +
          " meeting" +
          (stats.total_meetings === 1 ? "" : "s") +
          " captured · " +
          (stats.indexed_chunks || 0) +
          " chunks indexed for retrieval.";

    $("#navSummaries").textContent = stats.summaries || 0;
  }

  function meetingRow(m, withActions) {
    var shown = (m.speakers || []).slice(0, 3);
    var extra = (m.speakers || []).length - shown.length;
    return (
      "<tr>" +
      '<td class="name">' +
      highlight(m.meeting_id, state.query) +
      "</td>" +
      "<td>" +
      esc(fmtDateTime(m.started_at || m.last_seen)) +
      "</td>" +
      "<td>" +
      esc(fmtDuration(m.duration_seconds)) +
      "</td>" +
      '<td><span class="stack-avatars">' +
      shown
        .map(function (s) {
          return avatar(s);
        })
        .join("") +
      (extra > 0 ? '<span class="more">+' + extra + "</span>" : "") +
      "</span></td>" +
      "<td>" +
      esc((m.item_count || 0).toLocaleString()) +
      "</td>" +
      '<td style="text-align:right">' +
      (withActions
        ? '<button class="btn btn-subtle btn-sm" data-open-summary="' +
          esc(m.meeting_id) +
          '">Summary</button> '
        : "") +
      '<button class="btn btn-ghost btn-sm" data-open="' +
      esc(m.meeting_id) +
      '">View</button></td>' +
      "</tr>"
    );
  }

  function filteredMeetings() {
    if (!state.query) return state.meetings;
    var q = state.query.toLowerCase();
    return state.meetings.filter(function (m) {
      if (m.meeting_id.toLowerCase().indexOf(q) !== -1) return true;
      return (m.speakers || []).some(function (s) {
        return String(s).toLowerCase().indexOf(q) !== -1;
      });
    });
  }

  function renderMeetings() {
    var list = filteredMeetings();
    var empty =
      '<tr><td colspan="6">' +
      emptyState(
        state.query ? "No meetings match “" + esc(state.query) + "”." : "No meetings captured yet.",
        state.query ? "" : "Install the extension, join a Meet and turn on live captions."
      ) +
      "</td></tr>";

    $("#recentMeetings").innerHTML = list.length
      ? list
          .slice(0, 5)
          .map(function (m) {
            return meetingRow(m, false);
          })
          .join("")
      : empty;

    $("#allMeetings").innerHTML = list.length
      ? list
          .map(function (m) {
            return meetingRow(m, true);
          })
          .join("")
      : empty;

    $("#navMeetings").textContent = state.meetings.length;
  }

  function renderMeetingSelects() {
    var options = state.meetings
      .map(function (m) {
        return (
          '<option value="' +
          esc(m.meeting_id) +
          '">' +
          esc(m.meeting_id) +
          " (" +
          m.item_count +
          " lines)</option>"
        );
      })
      .join("");
    var withAll = '<option value="">All meetings</option>' + options;

    ["#transcriptMeeting", "#summaryMeeting"].forEach(function (sel) {
      var node = $(sel);
      node.innerHTML = options || '<option value="">No meetings yet</option>';
      if (state.activeMeeting) node.value = state.activeMeeting;
    });
    ["#actionMeeting", "#insightMeeting"].forEach(function (sel) {
      var node = $(sel);
      var previous = node.value;
      node.innerHTML = withAll;
      node.value = previous || "";
    });
  }

  function utteranceHTML(item, term) {
    return (
      '<div class="utterance">' +
      avatar(item.speaker) +
      '<div style="min-width:0"><div class="who-line"><b>' +
      esc(item.speaker || "Unknown") +
      "</b><time>" +
      esc(fmtClock(item.timestamp)) +
      "</time></div><p>" +
      highlight(item.text || "", term) +
      "</p></div></div>"
    );
  }

  function renderTranscript() {
    var term = $("#transcriptSearch").value.trim();
    var rows = state.transcript;
    if (term) {
      var q = term.toLowerCase();
      rows = rows.filter(function (r) {
        return (
          String(r.text || "").toLowerCase().indexOf(q) !== -1 ||
          String(r.speaker || "").toLowerCase().indexOf(q) !== -1
        );
      });
    }

    var body = $("#transcriptBody");
    var pinned = body.scrollTop + body.clientHeight >= body.scrollHeight - 40;

    body.innerHTML = rows.length
      ? rows
          .map(function (r) {
            return utteranceHTML(r, term);
          })
          .join("")
      : emptyState(
          state.activeMeeting
            ? term
              ? "Nothing matches “" + esc(term) + "” in this transcript."
              : "No lines stored for this meeting yet."
            : "Pick a meeting to see its transcript.",
          ""
        );

    if (pinned) body.scrollTop = body.scrollHeight;

    $("#transcriptTitle").textContent = state.activeMeeting
      ? state.activeMeeting + " · " + rows.length + " line" + (rows.length === 1 ? "" : "s")
      : "Transcript";

    // dashboard preview mirrors the tail of the same data
    $("#latestTranscript").innerHTML = state.transcript.length
      ? state.transcript
          .slice(-14)
          .map(function (r) {
            return utteranceHTML(r, "");
          })
          .join("")
      : emptyState("No transcript loaded.", "Captured lines appear here in real time.");
  }

  function renderBell() {
    var badge = $("#bellBadge");
    badge.hidden = state.unseen === 0;
    badge.textContent = state.unseen > 99 ? "99+" : state.unseen;
  }

  function renderIntegrations(health, assistant) {
    var items = [
      {
        name: "Google Meet",
        icon: '<rect x="2" y="6" width="13" height="12" rx="2"/><path d="M15 10l7-3v10l-7-3"/>',
        cls: "",
        ok: state.meetings.length > 0,
        on: "Capturing",
        off: "No captures yet",
      },
      {
        name: "Chrome Extension",
        icon: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.4"/><path d="M12 8.6H21M8.9 13.7 4.4 6M15.1 13.7 10.6 21.4"/>',
        cls: "green",
        ok: !!health.extension_zip_available,
        on: "Ready to download",
        off: "Sources not deployed",
      },
      {
        name: "Retrieval Index",
        icon: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/>',
        cls: "amber",
        ok: !!assistant.ready,
        on: (state.stats.indexed_chunks || 0) + " chunks indexed",
        off: "Not initialized",
      },
      {
        name: "LLM Provider",
        icon: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/>',
        cls: "blue",
        ok: !!currentApiKey(),
        on: ($("#llmProvider").value || "provider") + " key set",
        off: "Heuristic fallback",
      },
    ];

    $("#integrations").innerHTML = items
      .map(function (i) {
        return (
          '<div class="integration"><span class="icon-tile ' +
          i.cls +
          '"><svg viewBox="0 0 24 24">' +
          i.icon +
          "</svg></span><div><b>" +
          esc(i.name) +
          '</b><span class="status ' +
          (i.ok ? "ok" : "off") +
          '">' +
          esc(i.ok ? i.on : i.off) +
          "</span></div></div>"
        );
      })
      .join("");
  }

  /* ---------------------------------------------------------------- data -- */

  function loadStats() {
    return getJSON("/api/stats").then(renderStats);
  }

  function loadMeetings() {
    return getJSON("/api/meetings?limit=200").then(function (data) {
      state.meetings = data.items || [];
      renderMeetings();
      renderMeetingSelects();

      if (!state.activeMeeting && state.meetings.length) {
        var saved = localStorage.getItem(LS.meeting);
        var exists = state.meetings.some(function (m) {
          return m.meeting_id === saved;
        });
        selectMeeting(exists ? saved : state.meetings[0].meeting_id);
      }
    });
  }

  function selectMeeting(meetingId) {
    state.activeMeeting = meetingId || "";
    localStorage.setItem(LS.meeting, state.activeMeeting);
    ["#transcriptMeeting", "#summaryMeeting"].forEach(function (sel) {
      $(sel).value = state.activeMeeting;
    });
    return loadTranscript().then(loadSummaries);
  }

  function loadTranscript() {
    if (!state.activeMeeting) {
      state.transcript = [];
      renderTranscript();
      return Promise.resolve();
    }
    return getJSON(
      "/api/transcripts?meeting_id=" + encodeURIComponent(state.activeMeeting) + "&limit=1000"
    ).then(function (data) {
      state.transcript = data.items || [];
      renderTranscript();
    });
  }

  function loadSummaries() {
    var meetingId = $("#summaryMeeting").value || state.activeMeeting;
    if (!meetingId) {
      $("#summaryList").innerHTML = emptyState("No meeting selected.", "");
      $("#latestSummary").innerHTML = emptyState("No summary yet.", "");
      return Promise.resolve();
    }
    return getJSON(
      "/api/llm/history?meeting_id=" + encodeURIComponent(meetingId) + "&limit=100"
    ).then(function (data) {
      var items = (data.items || []).slice().reverse(); // newest first
      $("#summaryMeta").textContent =
        items.length + " run" + (items.length === 1 ? "" : "s") + " for " + meetingId;

      $("#summaryList").innerHTML = items.length
        ? items
            .map(function (item) {
              var badges =
                '<span class="chip' +
                (item.used_llm ? " brand" : "") +
                '">' +
                esc(item.used_llm ? item.provider || "llm" : "heuristic") +
                "</span>";
              return (
                '<div style="padding:12px 0;border-bottom:1px solid var(--line-soft)">' +
                '<div class="spread" style="margin-bottom:8px"><div class="row">' +
                '<span class="chip">' +
                esc(item.action) +
                "</span>" +
                badges +
                '</div><span class="tiny muted">' +
                esc(fmtDateTime(item.created_at)) +
                "</span></div>" +
                (item.question
                  ? '<p class="small" style="margin-bottom:6px"><strong>Q:</strong> ' +
                    esc(item.question) +
                    "</p>"
                  : "") +
                '<div class="summary-body">' +
                esc(item.result || "") +
                "</div></div>"
              );
            })
            .join("")
        : emptyState(
            "No summaries for this meeting yet.",
            'Hit <strong>Generate</strong> above — the heuristic fallback works without an API key.'
          );

      var latest = items.filter(function (i) {
        return i.action === "summarize";
      })[0];
      $("#summaryChip").textContent = latest
        ? (latest.used_llm ? latest.provider || "llm" : "heuristic") + " · " + meetingId
        : meetingId;
      $("#latestSummary").innerHTML = latest
        ? '<div class="summary-body">' + esc(latest.result) + "</div>"
        : emptyState(
            "No summary generated yet.",
            'Open <strong>Summaries</strong> and generate one.'
          );
    });
  }

  function loadActionItems() {
    var meetingId = $("#actionMeeting").value;
    var url = "/api/action-items" + (meetingId ? "?meeting_id=" + encodeURIComponent(meetingId) : "");
    return getJSON(url).then(function (data) {
      var items = data.items || [];
      $("#navActions").textContent = items.length;
      $("#actionMeta").textContent = items.length
        ? items.length + " extracted from stored summaries"
        : "";

      $("#actionList").innerHTML = items.length
        ? items
            .map(function (item, index) {
              var key = item.meeting_id + "|" + item.text;
              var done = state.done.has(key);
              return (
                '<div class="task' +
                (done ? " done" : "") +
                '"><input type="checkbox" id="task' +
                index +
                '" data-key="' +
                esc(key) +
                '"' +
                (done ? " checked" : "") +
                '><label for="task' +
                index +
                '">' +
                esc(item.text) +
                '<span class="tiny muted" style="display:block;margin-top:2px">' +
                esc(item.meeting_id) +
                " · " +
                esc(item.source === "section" ? "from an action-items section" : "matched by phrasing") +
                "</span></label>" +
                (item.owner ? '<span class="owner">' + esc(item.owner) + "</span>" : "<span></span>") +
                "</div>"
              );
            })
            .join("")
        : emptyState(
            "No action items yet.",
            "These are pulled out of generated summaries — generate one first."
          );
    });
  }

  function bars(node, rows, formatter) {
    if (!rows.length) {
      node.innerHTML = emptyState("Nothing to chart yet.", "");
      return;
    }
    var max = Math.max.apply(
      null,
      rows.map(function (r) {
        return r.value;
      })
    );
    node.innerHTML = rows
      .map(function (r) {
        var pct = max > 0 ? Math.max(2, (100 * r.value) / max) : 0;
        return (
          '<div class="bar-row"><span class="label" title="' +
          esc(r.label) +
          '">' +
          esc(r.label) +
          '</span><span class="bar-track"><span class="bar-fill" style="width:' +
          pct.toFixed(1) +
          '%"></span></span><span class="value">' +
          esc(formatter(r)) +
          "</span></div>"
        );
      })
      .join("");
  }

  function loadInsights() {
    var meetingId = $("#insightMeeting").value;
    var url = "/api/insights" + (meetingId ? "?meeting_id=" + encodeURIComponent(meetingId) : "");
    return getJSON(url).then(function (data) {
      bars(
        $("#speakerBars"),
        (data.speakers || []).map(function (s) {
          return { label: s.speaker, value: s.words, share: s.share, lines: s.lines };
        }),
        function (r) {
          return r.share + "%";
        }
      );

      bars(
        $("#providerBars"),
        (data.providers || []).map(function (p) {
          return { label: p.provider + " · " + p.action, value: p.runs };
        }),
        function (r) {
          return r.value + " run" + (r.value === 1 ? "" : "s");
        }
      );

      var activity = data.activity || [];
      var max = Math.max.apply(
        null,
        [1].concat(
          activity.map(function (a) {
            return a.lines;
          })
        )
      );
      $("#activitySpark").innerHTML = activity.length
        ? activity
            .map(function (a) {
              return (
                '<div style="height:' +
                Math.max(3, (100 * a.lines) / max).toFixed(1) +
                '%" title="' +
                esc(a.day + ": " + a.lines + " lines") +
                '"></div>'
              );
            })
            .join("")
        : "";
      $("#activityLabels").innerHTML = activity
        .map(function (a) {
          return "<span>" + esc(String(a.day).slice(5)) + "</span>";
        })
        .join("");
      if (!activity.length) {
        $("#activityLabels").innerHTML = "";
        $("#activitySpark").innerHTML = emptyState("No capture activity recorded.", "");
      }
    });
  }

  function loadAssistantStatus() {
    return getJSON("/api/assistant/status").then(function (data) {
      var stats = data.stats || {};
      $("#assistantStats").innerHTML = data.ready
        ? '<span class="status ok">Ready</span><div class="tiny muted" style="margin-top:8px">' +
          Object.keys(stats)
            .map(function (k) {
              return esc(k.replace(/_/g, " ")) + ": <strong>" + esc(stats[k]) + "</strong>";
            })
            .join(" · ") +
          "</div>"
        : '<span class="status off">Not initialized</span><div class="tiny muted" style="margin-top:8px">' +
          "Summaries and questions fall back to raw transcript rows.</div>";
    });
  }

  function loadHealth() {
    return getJSON("/health").then(function (data) {
      $("#healthBody").innerHTML = Object.keys(data)
        .map(function (key) {
          var value = data[key];
          var cls = value === true || value === "ok" ? "ok" : value === false ? "off" : "";
          return (
            '<div class="spread" style="padding:7px 0;border-bottom:1px solid var(--line-soft)">' +
            "<span>" +
            esc(key.replace(/_/g, " ")) +
            '</span><span class="status ' +
            cls +
            '">' +
            esc(String(value)) +
            "</span></div>"
          );
        })
        .join("");
    });
  }

  function loadDashboardStatus() {
    return Promise.all([
      getJSON("/health").catch(function () {
        return {};
      }),
      getJSON("/api/assistant/status").catch(function () {
        return {};
      }),
    ]).then(function (results) {
      renderIntegrations(results[0], results[1]);
    });
  }

  /* ------------------------------------------------------------ providers -- */

  function currentApiKey() {
    var provider = $("#llmProvider").value;
    if (provider === "openai") return $("#keyOpenai").value.trim();
    if (provider === "groq") return $("#keyGroq").value.trim();
    if (provider === "gemini") return $("#keyGemini").value.trim();
    return "";
  }

  function updateKeyVisibility() {
    var provider = $("#llmProvider").value;
    $("#keyOpenaiRow").style.display = provider === "openai" ? "flex" : "none";
    $("#keyGroqRow").style.display = provider === "groq" ? "flex" : "none";
    $("#keyGeminiRow").style.display = provider === "gemini" ? "flex" : "none";
    var hasKey = !!currentApiKey();
    var chip = $("#keyChip");
    chip.textContent = hasKey ? "key set" : "no key — heuristic fallback";
    chip.classList.toggle("brand", hasKey);
  }

  function loadProviders() {
    return getJSON("/api/llm/providers").then(function (data) {
      $("#llmProvider").innerHTML = (data.items || [])
        .map(function (p) {
          return (
            '<option value="' +
            esc(p.id) +
            '">' +
            esc(p.label) +
            " (default: " +
            esc(p.default_model || "n/a") +
            ")</option>"
          );
        })
        .join("");

      $("#keyOpenai").value = localStorage.getItem(LS.openai) || "";
      $("#keyGroq").value = localStorage.getItem(LS.groq) || "";
      $("#keyGemini").value = localStorage.getItem(LS.gemini) || "";
      $("#modelName").value = localStorage.getItem(LS.model) || "";
      var savedProvider = localStorage.getItem(LS.provider);
      if (savedProvider) $("#llmProvider").value = savedProvider;
      $("#allowFallback").checked = localStorage.getItem(LS.fallback) !== "0";
      $("#useRag").checked = localStorage.getItem(LS.rag) !== "0";
      updateKeyVisibility();
    });
  }

  function llmPayload(meetingId, action, question) {
    return {
      meeting_id: meetingId,
      action: action,
      question: question || null,
      provider: $("#llmProvider").value,
      api_key: currentApiKey() || null,
      model: $("#modelName").value.trim() || null,
      allow_fallback: $("#allowFallback").checked,
      use_rag_context: $("#useRag").checked,
    };
  }

  /* ----------------------------------------------------------- websocket -- */

  function setWsChip(text, ok) {
    ["#wsChip", "#wsChip2"].forEach(function (sel) {
      var chip = $(sel);
      chip.textContent = text;
      chip.classList.toggle("brand", !!ok);
    });
  }

  function connectWs() {
    if (state.ws) state.ws.close();
    if (state.keepAlive) clearInterval(state.keepAlive);

    var proto = location.protocol === "https:" ? "wss" : "ws";
    var socket = new WebSocket(proto + "://" + location.host + "/ws/transcripts");
    state.ws = socket;

    socket.onopen = function () {
      setWsChip("live", true);
    };
    socket.onerror = function () {
      setWsChip("connection error", false);
    };
    socket.onclose = function () {
      setWsChip("reconnecting…", false);
      setTimeout(connectWs, 1500);
    };
    socket.onmessage = function (event) {
      var message;
      try {
        message = JSON.parse(event.data || "{}");
      } catch (err) {
        return;
      }
      if (message.type !== "transcript_batch") return;

      if (message.meeting_id === state.activeMeeting) {
        state.transcript = state.transcript.concat(message.items || []);
        renderTranscript();
        if (state.view !== "transcripts") {
          state.unseen += (message.items || []).length;
          renderBell();
        }
      } else if (
        !state.meetings.some(function (m) {
          return m.meeting_id === message.meeting_id;
        })
      ) {
        // a meeting we have never seen just started capturing
        loadMeetings();
        toast("New meeting capturing: " + message.meeting_id);
      }
    };

    // The server's receive loop stays alive only while the client sends; this
    // also keeps a sleeping free-tier instance awake during a demo.
    state.keepAlive = setInterval(function () {
      if (state.ws && state.ws.readyState === 1) state.ws.send("ping");
    }, 10000);
  }

  /* --------------------------------------------------------------- wiring -- */

  function refreshAll() {
    return Promise.all([loadStats(), loadMeetings()])
      .then(loadDashboardStatus)
      .catch(function (err) {
        toast("Could not reach the server: " + err.message, true);
      });
  }

  function bind() {
    $("#sideNav").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-view]");
      if (btn) setView(btn.getAttribute("data-view"));
    });

    document.addEventListener("click", function (e) {
      var goto = e.target.closest("[data-goto]");
      if (goto) {
        setView(goto.getAttribute("data-goto"));
        return;
      }
      var open = e.target.closest("[data-open]");
      if (open) {
        selectMeeting(open.getAttribute("data-open")).then(function () {
          setView("transcripts");
        });
        return;
      }
      var openSummary = e.target.closest("[data-open-summary]");
      if (openSummary) {
        $("#summaryMeeting").value = openSummary.getAttribute("data-open-summary");
        selectMeeting(openSummary.getAttribute("data-open-summary")).then(function () {
          setView("summaries");
        });
      }
    });

    $("#backHome").addEventListener("click", function () {
      location.href = "/";
    });

    $("#refreshBtn").addEventListener("click", function () {
      refreshAll().then(function () {
        toast("Refreshed");
      });
    });

    $("#bellBtn").addEventListener("click", function () {
      if (state.unseen) setView("transcripts");
      else toast(state.ws && state.ws.readyState === 1 ? "Live and connected." : "Not connected.");
    });

    var searchTimer = null;
    $("#globalSearch").addEventListener("input", function (e) {
      clearTimeout(searchTimer);
      var value = e.target.value.trim();
      searchTimer = setTimeout(function () {
        state.query = value;
        renderMeetings();
      }, 140);
    });

    document.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        $("#globalSearch").focus();
        $("#globalSearch").select();
      }
      if (e.key === "Escape" && !$("#newMeetingModal").hidden) closeModal();
    });

    $("#transcriptMeeting").addEventListener("change", function (e) {
      selectMeeting(e.target.value);
    });
    $("#transcriptSearch").addEventListener("input", renderTranscript);
    $("#clearTranscript").addEventListener("click", function () {
      state.transcript = [];
      renderTranscript();
      toast("View cleared — reload the meeting to fetch stored lines again.");
    });

    $("#summaryMeeting").addEventListener("change", loadSummaries);
    $("#actionMeeting").addEventListener("change", loadActionItems);
    $("#insightMeeting").addEventListener("change", loadInsights);

    $("#generateSummary").addEventListener("click", function () {
      var meetingId = $("#summaryMeeting").value;
      if (!meetingId) return toast("Pick a meeting first.", true);
      var btn = this;
      btn.disabled = true;
      btn.textContent = "Generating…";
      postJSON("/api/llm/action", llmPayload(meetingId, "summarize", null))
        .then(function (data) {
          toast(data.used_llm ? "Summary generated." : "Generated with the heuristic fallback.");
          return Promise.all([loadSummaries(), loadStats(), loadActionItems()]);
        })
        .catch(function (err) {
          toast("Summary failed: " + err.message, true);
        })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = "Generate";
        });
    });

    $("#askBtn").addEventListener("click", function () {
      var question = $("#askInput").value.trim();
      if (!state.activeMeeting) return toast("Pick a meeting first.", true);
      if (!question) return toast("Type a question first.", true);
      var btn = this;
      btn.disabled = true;
      $("#askResult").textContent = "Thinking…";
      var payload = llmPayload(state.activeMeeting, "qa", question);
      payload.use_rag_context = $("#askUseRag").checked;
      postJSON("/api/llm/action", payload)
        .then(function (data) {
          $("#askResult").classList.remove("muted");
          $("#askResult").textContent = data.result || "No result.";
          toast(
            "Answered from " +
              (data.context_mode === "rag" ? "retrieved chunks" : "raw transcript rows") +
              " (" +
              data.context_items +
              " items)."
          );
          return loadStats();
        })
        .catch(function (err) {
          $("#askResult").textContent = "Failed: " + err.message;
          toast("Question failed: " + err.message, true);
        })
        .finally(function () {
          btn.disabled = false;
        });
    });

    $("#askInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter") $("#askBtn").click();
    });

    $("#actionList").addEventListener("change", function (e) {
      var box = e.target.closest('input[type="checkbox"]');
      if (!box) return;
      var key = box.getAttribute("data-key");
      if (box.checked) state.done.add(key);
      else state.done.delete(key);
      box.closest(".task").classList.toggle("done", box.checked);
      localStorage.setItem(LS.done, JSON.stringify(Array.from(state.done)));
    });

    // settings persistence
    $("#llmProvider").addEventListener("change", function () {
      localStorage.setItem(LS.provider, $("#llmProvider").value);
      updateKeyVisibility();
      loadDashboardStatus();
    });
    [
      ["#keyOpenai", LS.openai],
      ["#keyGroq", LS.groq],
      ["#keyGemini", LS.gemini],
      ["#modelName", LS.model],
    ].forEach(function (pair) {
      $(pair[0]).addEventListener("change", function (e) {
        localStorage.setItem(pair[1], e.target.value.trim());
        updateKeyVisibility();
        loadDashboardStatus();
      });
    });
    $("#allowFallback").addEventListener("change", function (e) {
      localStorage.setItem(LS.fallback, e.target.checked ? "1" : "0");
    });
    $("#useRag").addEventListener("change", function (e) {
      localStorage.setItem(LS.rag, e.target.checked ? "1" : "0");
    });

    $("#forceIngest").addEventListener("click", function () {
      var btn = this;
      btn.disabled = true;
      postJSON("/api/assistant/ingest")
        .then(function (data) {
          toast(data.ok ? "Ingest cycle finished." : data.error || "Assistant is not ready.", !data.ok);
          return Promise.all([loadAssistantStatus(), loadStats()]);
        })
        .catch(function (err) {
          toast("Ingest failed: " + err.message, true);
        })
        .finally(function () {
          btn.disabled = false;
        });
    });

    $("#refreshHealth").addEventListener("click", loadHealth);

    $("#exportMeetings").addEventListener("click", function () {
      var blob = new Blob([JSON.stringify(state.meetings, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = "meetingiq-meetings.json";
      link.click();
      URL.revokeObjectURL(url);
    });

    // modal
    $("#newMeetingBtn").addEventListener("click", function () {
      $("#newMeetingModal").hidden = false;
      $("#jumpMeeting").focus();
    });
    $("#closeModal").addEventListener("click", closeModal);
    $("#newMeetingModal").addEventListener("click", function (e) {
      if (e.target === this) closeModal();
    });
    $("#jumpBtn").addEventListener("click", function () {
      var meetingId = $("#jumpMeeting").value.trim();
      if (!meetingId) return toast("Enter a meeting id.", true);
      closeModal();
      selectMeeting(meetingId).then(function () {
        setView("transcripts");
      });
    });

    window.addEventListener("hashchange", function () {
      setView((location.hash || "").replace("#/", ""));
    });
  }

  function closeModal() {
    $("#newMeetingModal").hidden = true;
  }

  /* ----------------------------------------------------------------- boot -- */

  $("#year").textContent = new Date().getFullYear();
  $("#extTarget").textContent = location.origin + "/transcript";

  bind();
  loadProviders()
    .then(refreshAll)
    .then(function () {
      setView((location.hash || "").replace("#/", "") || "dashboard");
    })
    .catch(function (err) {
      toast("Startup failed: " + err.message, true);
    });

  connectWs();

  // Meetings and counters drift as captures land; the transcript itself arrives
  // over the socket, so this only refreshes the aggregates.
  setInterval(function () {
    if (document.hidden) return;
    loadStats().catch(function () {});
    loadMeetings().catch(function () {});
  }, 15000);
})();
