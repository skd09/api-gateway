// =================================================================
// MIDDLEWARE TYPES
// =================================================================
//
// Every middleware receives a GatewayContext and a next() function.
//
// GatewayContext carries data between middleware:
//   - The Express req/res
//   - Selected backend (set by load balancer)
//   - Circuit breaker (set by circuit breaker middleware)
//   - Metrics, timing, etc.
//
// next() passes control to the next middleware in the chain.
// If a middleware doesn't call next(), the chain stops.
// This is how rate limiting rejects requests — it never calls next().
// =================================================================

import { Request, Response } from "express";
import { Backend } from "../load-balancers/types";
import { CircuitBreaker } from "../circuit-breaker/circuit-breaker";

export interface GatewayContext {
    req: Request;
    res: Response;
    startTime: number;

    // Set by middleware as request flows through
    clientKey: string;
    backend?: Backend;
    circuitBreaker?: CircuitBreaker;

    // Metadata — any middleware can attach data
    meta: Record<string, any>;
}

export type NextFunction = () => Promise<void>;

export interface GatewayMiddleware {
    name: string;
    handle(ctx: GatewayContext, next: NextFunction): Promise<void>;
}