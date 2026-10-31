// FDE Council · live mode for app3.html
// Open app3.html?live=1 (bridge must be running: `cd bridge && bun run start`, port 4000).
// Replaces the scripted Northwind replay with a real debate from the bridge + actors:
//   POST /debate -> SeminarActor socket -> agent events drive the existing animations.
// The FDE box and Approve button call the real endpoints. Without ?live=1 nothing changes.
(function () {
    const params = new URLSearchParams(location.search)
    // Live is the default. Add ?replay=1 to see the old scripted demo instead.
    if (params.has("replay")) return
    const BRIDGE = params.get("bridge") || "http://localhost:4000"

    // --- Halloween clients mapped onto the page's 5 existing pumpkins --------------------
    const ID = { "client-1": "northwind", "client-2": "lumen", "client-3": "harbor", "client-4": "orbit", "client-5": "atlas" }
    const CLIENT = Object.fromEntries(Object.entries(ID).map(([c, p]) => [p, c]))
    const NAMES = {
        northwind: ["Hallow Tix", "Haunted-house tickets · Next.js · Postgres · Stripe"],
        lumen: ["Costume Cauldron", "Costume store · CDN · serverless"],
        harbor: ["Pumpkin Patch Pass", "Time-slot bookings · Postgres"],
        orbit: ["Candy Courier", "Candy delivery · payments queue"],
        atlas: ["Ghost Tour Co.", "Ghost tours · mobile app"],
    }
    const REQUEST =
        params.get("request") ||
        "Tonight at 6pm we release 5,000 haunted-house tickets and expect 50,000 people at once. Don't let the site crash or sell the same ticket twice."

    for (const [id, [name, stack]] of Object.entries(NAMES)) {
        BY[id].name = name
        BY[id].stack = stack
        const b = nodes[id] && nodes[id].lbl.querySelector("b")
        if (b) b.textContent = name
    }
    EMAIL.from = "Morgan Graves"
    EMAIL.role = "CTO · Hallow Tix"
    EMAIL.subj = "Tonight's ticket drop: 50,000 people at 6pm"
    EMAIL.body = ["Hi,", REQUEST, "Can the council get us a plan in the next hour?", "Thanks, Morgan"]
    TASKS.length = 0
    TASKS.push(
        ["Hallow Tix: load-test checkout before 6pm", "northwind", "Today"],
        ["Costume Cauldron: Nov 1 returns flow", "lumen", "Tomorrow"],
        ["Pumpkin Patch: weekend slot release", "harbor", "Fri"],
        ["Candy Courier: payment provider limits review", "orbit", "Fri"],
        ["Ghost Tour Co.: offline audio QA", "atlas", "Next week"],
    )
    renderProjects()
    renderTasks()
    $("#sbproj").innerHTML = P.map(p => `<div class="pj"><i style="background:${p.color}"></i>${p.name}<span class="ag">${pumpSVG()}</span></div>`).join("")
    SIGNALS.length = 0
    SIGNALS.push(
        ["northwind", "ST", "6pm ticket drop · 5,000 tickets"],
        ["lumen", "SH", "costume orders up 8x today"],
        ["harbor", "GH", "slot-hold fix deployed"],
        ["orbit", "PD", "payment provider rate limit warning"],
        ["atlas", "SL", "night tours fully booked"],
        ["northwind", "CA", "load test at 4pm"],
    )

    // Halloween quick-constraint chips and menu labels (replace the old dark-mode ones).
    const CHIPS = [
        ["$300 budget", "Hallow Tix only has a $300 cloud budget for tonight."],
        ["Stay on Stripe", "Checkout must stay on Stripe, no new vendors tonight."],
        ["No waiting room", "The CEO says no waiting room, people hate queues."],
    ]
    document.querySelectorAll(".quick button").forEach((btn, i) => {
        if (!CHIPS[i]) return btn.remove()
        btn.textContent = CHIPS[i][0]
        btn.dataset.q = CHIPS[i][1]
    })
    const reqItem = document.querySelector('#pal .it[data-c="req"]')
    if (reqItem) reqItem.textContent = "▤ Open the Hallow Tix request"

    window.show = function (v) {
        if (v === "council") v = "req"
        document.querySelectorAll(".view").forEach(x => x.classList.toggle("on", x.id === "v-" + v))
        $("#crumb").innerHTML = v === "home" ? "<b>Home</b>" : "Requests<span>/</span><b>Hallow Tix · Halloween rush</b>"
        if (v === "req") requestAnimationFrame(layout)
    }

    // --- live state ------------------------------------------------------------------------
    let seminarId = null
    let awaitingApproval = false
    let planVersion = 0
    const sentByMe = new Set()
    let queue = Promise.resolve()
    const enqueue = fn => (queue = queue.then(fn).catch(err => console.error("[live]", err)))
    const lastTyping = {}

    async function api(path, body) {
        const res = await fetch(BRIDGE + path, body === undefined ? {} : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error(path + " → " + res.status + " " + (await res.text()))
        return res.json()
    }

    function planCard(text, cites) {
        // Split "1) ... 2) ..." / "1. ... 2. ..." into steps; fall back to sentences.
        let parts = text.split(/\s*(?:^|\s)\d+[.)]\s+/).map(s => s.trim()).filter(Boolean)
        if (parts.length < 2) parts = text.split(/;\s+|(?<=\.)\s+/).map(s => s.trim()).filter(Boolean)
        if (parts.length < 2) parts = text.split(/,\s+(?:and\s+)?|\s+and\s+(?=(?:put|run|use|add|enforce|keep|cache|gate|hold|queue)\b)/i).map(s => s.trim()).filter(s => s.length > 12)
        if (parts.length > 1 && !/\(client-\d\)|client-\d/.test(parts[0]) && parts[0].length < 60) parts.shift()
        parts = parts.map(p => p.replace(/^(I'm going to|I will|I'll)\s+/i, "")).map(p => p.charAt(0).toUpperCase() + p.slice(1))
        const steps = parts.slice(0, 6).map(p => {
            const m = p.match(/client-(\d)/)
            const src = m ? ID["client-" + m[1]] : "northwind"
            return { text: p.replace(/\s*\((?:client-\d[,;\s]*|fde[,;\s]*)+\)\s*/g, " ").replace(/[;,]\s*$/, "").trim(), src }
        })
        const n = (cites || []).length
        planVersion++
        return {
            ver: planVersion === 1 ? "v1 · from the council" : "v" + planVersion + " · adjusted by you",
            v2: planVersion > 1,
            title: "Survive tonight's 6pm ticket drop",
            why: "Built from " + n + " client lessons. Each step credits the deployment it came from.",
            eta: "before 6pm",
            conf: planVersion > 1 ? 88 : 74,
            steps: steps.length ? steps : [{ text, src: "northwind" }],
        }
    }

    function onEvent(e) {
        const pid = ID[e.from]
        if (e.type === "request") return
        if (e.type === "fde") {
            if (sentByMe.has(e.text) || /^Approved the plan/.test(e.text)) return
            enqueue(() => addMessage({ from: "fde", kind: "fde", text: e.text }))
            return
        }
        if (!pid) return
        if (e.type === "plan") {
            enqueue(async () => {
                cstat(pid, "idle")
                handle({ type: "hub", on: false })
                cap("Consensus reached.", "One next step drafted for you.")
                await suggest(planCard(e.text, e.cites))
                $("#n-impact").innerHTML =
                    '<span class="ok">No double-sold tickets</span><span class="ok">Site stays up at 6pm</span><span>Saved to the client\'s memory on approve</span>'
                $("#n-diff").textContent = planVersion > 1 ? "Rewritten by Hallow Tix with your feedback" : ""
                awaitingApproval = true
                arm()
                $("#fdeinput").placeholder = "Reject with feedback, e.g. 'We only have a $300 cloud budget'"
            })
            return
        }
        const kind = e.type === "abstain" ? "none" : e.type === "challenge" ? (/disagree|won't|not enough|broke/i.test(e.text) ? "objection" : "revision") : "lesson"
        enqueue(async () => {
            cstat(pid, kind === "objection" ? "objecting" : "speaking")
            if (kind === "objection") cap(BY[pid].name + " objects.", e.text.slice(0, 90) + (e.text.length > 90 ? "…" : ""))
            await addMessage({ from: pid, kind, text: e.text })
            cstat(pid, "idle")
        })
    }

    async function connect() {
        const grant = await api("/seminar/" + seminarId + "/socket")
        const ws = new WebSocket(grant.websocketUrl)
        ws.onmessage = m => {
            const msg = JSON.parse(m.data)
            if (msg.type === "event") onEvent(msg.event)
            else if (msg.type === "typing") {
                const pid = ID[msg.from]
                if (pid && Date.now() - (lastTyping[pid] || 0) > 800) {
                    lastTyping[pid] = Date.now()
                    cstat(pid, "thinking")
                }
            }
        }
        ws.onerror = () => toast("Live connection error", "Is the actor server running?")
    }

    // --- overrides ---------------------------------------------------------------------------
    const scriptedReceive = receive
    window.receive = async function () {
        if (seminarId) return
        SCRIPT.length = 0 // reuse the page's own setup, but play nothing scripted
        await scriptedReceive()
        const av = document.querySelector("#emailcard .av")
        if (av) av.textContent = "MG"
        handle({ type: "act", id: "l1", text: "Picked up the email", sub: "Hallow Tix · matched by sender", state: "done" })
        handle({ type: "act", id: "l2", text: "Asked the council", sub: "4 other agents · lessons only, never code or client data", state: "run" })
        handle({ type: "hub", on: true })
        cap("Hallow Tix asks the council.", "Each agent searches only its own client's memory.")
        cstat("northwind", "asking")
        for (const p of ["lumen", "harbor", "orbit", "atlas"]) cstat(p, "thinking")
        try {
            const r = await api("/debate", { client: "client-1", request: REQUEST })
            seminarId = r.seminarId
            await connect()
            $("#adjust").classList.add("show") // FDE can jump in from the start
            $("#fdeinput").placeholder = "Jump in with a constraint, e.g. 'Checkout must stay on Stripe'"
        } catch (err) {
            toast("Could not start the debate", String(err.message || err))
        }
    }

    window.sendFde = async function () {
        const i = $("#fdeinput")
        const text = i.value.trim()
        if (!text || !seminarId) return
        i.value = ""
        sentByMe.add(text)
        enqueue(() => addMessage({ from: "fde", kind: "fde", text }))
        try {
            if (awaitingApproval) {
                awaitingApproval = false
                $("#adjust").classList.remove("show")
                $("#nextcard").classList.remove("waiting")
                $("#next-eye").textContent = "Re-planning with your feedback…"
                $("#nextcard").style.opacity = 0.6
                await api("/seminar/" + seminarId + "/reject", { text })
            } else {
                await api("/seminar/" + seminarId + "/fde", { text })
            }
        } catch (err) {
            toast("Could not send", String(err.message || err))
        }
    }

    const scriptedApprove = approve
    window.approve = async function () {
        if (!seminarId || !awaitingApproval) return
        awaitingApproval = false
        try {
            await api("/seminar/" + seminarId + "/approve", {})
        } catch (err) {
            toast("Approve failed", String(err.message || err))
            return
        }
        $("#nextcard").style.opacity = 1
        await scriptedApprove()
        const a9 = document.querySelector("#act-a9 small")
        if (a9) a9.textContent = "Plan saved to Supabase · remembered by Hallow Tix's agent"
        $("#draft-t").textContent =
            "Hi Morgan, the council has a plan for tonight: a virtual waiting room, short ticket holds so nothing sells twice, and cached pages for everything but inventory. Saved to Hallow Tix's memory for next year."
        TASKS[0] = ["Hallow Tix: 6pm ticket-drop plan", "northwind", "Today", "new"]
        renderTasks()
        toast("Approved · Hallow Tix", "Plan saved to Supabase and to Hallow Tix's memory")
    }

    // Re-bind handlers that captured the scripted functions.
    $("#demobtn").onclick = () => window.receive()
    $("#approve").onclick = () => window.approve()
    $("#demobtn").textContent = "Start live request"
    console.log("[live] FDE Council live mode → " + BRIDGE)
})()
