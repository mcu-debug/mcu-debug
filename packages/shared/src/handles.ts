/**
 * Interface for objects that can generate their own unique content-based key.
 */
export interface IValueIdentifiable {
    /**
     * Returns a string representation that uniquely identifies the value
     * of this object. (e.g. "User:123:v1")
     */
    toValueKey(): string;
}

/**
 * A registry that assigns a unique integer handle to objects based on
 * their structural value (deep equality) rather than reference.
 *
 * Note: Can be Expensive. The default implementation uses a stable
 * JSON.stringify to determine object equality. For better performance,
 * objects can implement IValueIdentifiable to provide their own
 * unique value-based key.
 *
 * Usage:
 *   const registry = new ValueHandleRegistry<MyType>();
 *   const handle = registry.getHandle(myObject);
 *   const sameHandle = registry.getHandle(anotherObjectWithSameValue);
 *   const originalObject = registry.getObject(handle);
 */

export class ValueHandleRegistry<T = any> {
    private keyToHandle = new Map<string, number>();
    private handleToObj = new Map<number, T>();
    private counter = 0;

    /**
     * Get a handle for an object. If the object (by value) has been seen before,
     * returns the existing handle. Otherwise, creates a new one.
     */
    public addObject(obj: T): number {
        const key = this.getKey(obj);

        let handle = this.keyToHandle.get(key);
        if (handle !== undefined) {
            return handle;
        }

        handle = ++this.counter;
        this.keyToHandle.set(key, handle);
        this.handleToObj.set(handle, obj);
        return handle;
    }

    public getHandle(obj: T): number | undefined {
        const key = this.getKey(obj);
        const handle = this.keyToHandle.get(key);
        return handle;
    }

    public getObject(handle: number): T | undefined {
        return this.handleToObj.get(handle);
    }

    public getObjectByKey(key: T): T | undefined {
        const handle = this.keyToHandle.get(this.getKey(key));
        if (handle !== undefined) {
            return this.handleToObj.get(handle);
        }
        return undefined;
    }

    public release(handle: number): boolean {
        const obj = this.handleToObj.get(handle);
        if (!obj) return false;

        const key = this.getKey(obj);
        this.keyToHandle.delete(key);
        this.handleToObj.delete(handle);
        return true;
    }

    /**
     * Determines the unique key for an object using the hybrid strategy.
     */
    private getKey(obj: any): string {
        // 1. Optimization: Check if object generates its own key
        if (isValueIdentifiable(obj)) {
            return obj.toValueKey();
        }
        // 2. Fallback: Structural equality
        return this.stableStringify(obj);
    }

    /**
     * Recursively stringifies an object with sorted keys.
     * Respects IValueIdentifiable during recursion.
     */
    private stableStringify(val: any): string {
        // Check for Interface deep in the tree
        if (isValueIdentifiable(val)) {
            return val.toValueKey();
        }

        // Primitives / Null
        if (val === null || typeof val !== "object") {
            return JSON.stringify(val);
        }

        // Native Types that don't serialize well with Object.keys()
        if (val instanceof Date) return JSON.stringify(val.toISOString());
        if (val instanceof RegExp) return JSON.stringify(val.toString());

        // Arrays
        if (Array.isArray(val)) {
            return "[" + val.map((item) => this.stableStringify(item)).join(",") + "]";
        }

        // Objects: Sort keys for determinism
        const keys = Object.keys(val).sort();
        const parts = keys.map((key) => {
            return JSON.stringify(key) + ":" + this.stableStringify(val[key]);
        });

        return "{" + parts.join(",") + "}";
    }

    public clear() {
        this.keyToHandle.clear();
        this.handleToObj.clear();
        this.counter = 0;
    }
}

// Type Guard: safely checks if an object implements the interface
function isValueIdentifiable(obj: any): obj is IValueIdentifiable {
    return obj && typeof obj.toValueKey === "function";
}

export class ValueHandleRegistryPrimitive<T = string | number | boolean | BigInt> {
    private keyToHandle = new Map<T, number>();
    private handleToItem = new Map<number, T>();
    private counter = 0;

    add(item: T): number {
        this.counter++;

        this.keyToHandle.set(item, this.counter);
        this.handleToItem.set(this.counter, item);
        return this.counter;
    }

    getObject(handle: number): T | undefined {
        return this.handleToItem.get(handle);
    }

    release(handle: number): boolean {
        const obj = this.handleToItem.get(handle);
        if (!obj) return false;

        this.keyToHandle.delete(obj);
        this.handleToItem.delete(handle);
        return true;
    }

    clear() {
        this.keyToHandle.clear();
        this.handleToItem.clear();
        this.counter = 0;
    }
}
