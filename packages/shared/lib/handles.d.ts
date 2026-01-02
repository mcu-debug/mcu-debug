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
export declare class ValueHandleRegistry<T = any> {
    private keyToHandle;
    private handleToObj;
    private counter;
    /**
     * Get a handle for an object. If the object (by value) has been seen before,
     * returns the existing handle. Otherwise, creates a new one.
     */
    addObject(obj: T): number;
    getHandle(obj: T): number | undefined;
    getObject(handle: number): T | undefined;
    getObjectByKey(key: T): T | undefined;
    release(handle: number): boolean;
    /**
     * Determines the unique key for an object using the hybrid strategy.
     */
    private getKey;
    /**
     * Recursively stringifies an object with sorted keys.
     * Respects IValueIdentifiable during recursion.
     */
    private stableStringify;
    clear(): void;
}
export declare class ValueHandleRegistryPrimitive<T = string | number | boolean | BigInt> {
    private keyToHandle;
    private handleToItem;
    private counter;
    add(item: T): number;
    get(handle: number): T | undefined;
    release(handle: number): boolean;
    clear(): void;
}
