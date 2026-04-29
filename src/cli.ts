#!/usr/bin/env bun
import { serve } from "./server";

const port = Number(process.env.PORT ?? 7878);
serve(port);
console.log(`stream.md listening on http://localhost:${port}`);
