/** 4 KiB blocks avoid JS-number arrays and geometric capacity doubling.
 * At most 30 partial blocks (six batches × five attributes) exist per part.
 * Sealing allocates the final exact attribute once, then releases its blocks.
 */
export class MeshScratch {
  constructor(Type = Float32Array) {
    this.Type = Type;
    this.blocks = [];
    this.length = 0;
  }
  push(...values) {
    for (const value of values) {
      const block = Math.floor(this.length / 1024), offset = this.length % 1024;
      if (!this.blocks[block]) this.blocks[block] = new this.Type(1024);
      this.blocks[block][offset] = value;
      this.length++;
    }
  }
  every(predicate) {
    for (let i = 0; i < this.length; i++)
      if (!predicate(this.blocks[Math.floor(i / 1024)][i % 1024])) return false;
    return true;
  }
  seal(Type = this.Type) {
    const array = new Type(this.length);
    for (let i = 0; i < this.blocks.length; i++) {
      const start = i * 1024;
      array.set(this.blocks[i].subarray(0, Math.min(1024, this.length - start)), start);
    }
    this.blocks = [];
    return array;
  }
}
