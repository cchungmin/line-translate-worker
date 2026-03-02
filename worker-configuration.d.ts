export {};

declare global {
	type Env = import('./src/types').Env;
	type ExecutionContext = import('./src/types').ExecutionContext;
	type ExportedHandler<E = Env> = import('./src/types').ExportedHandler<E>;
}
