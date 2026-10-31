// Shared contract for FDE Council. Do not change without telling the team.

export type EventType = "request" | "take" | "abstain" | "challenge" | "fde" | "plan"

export type ClientId = "client-1" | "client-2" | "client-3" | "client-4" | "client-5"

export type CouncilEvent = {
    type: EventType
    from: ClientId | "fde"
    text: string
    cites?: string[]
    ts: number
}

export type Memory = {
    request: string
    solution: string
    what_broke: string
    fix: string
    stack: string
    outcome: string
}

export type ClientProfile = {
    name: string
    stack: string
    constraints: string[]
}

export type SeminarStatus = "idle" | "running" | "done"
