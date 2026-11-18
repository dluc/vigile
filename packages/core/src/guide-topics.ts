/**
 * The topics of the guide. They stand in a file of their own because the guide names operations and one
 * operation, get_guide, names the topics: each can load this without loading the other first.
 */
export const GUIDE_TOPICS = ["overview", "organising", "working", "examples"] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];
