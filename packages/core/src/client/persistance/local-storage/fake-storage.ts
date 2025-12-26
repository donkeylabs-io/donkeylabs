export class FakeLocalStorage implements Storage {
  private data: { [key: string]: string } = {};

  length: number = 0;

  clear(): void {
    this.data = {};
    this.length = 0;
  }

  getItem(key: string): string | null {
    return this.data[key] || null;
  }

  setItem(key: string, value: string): void {
    this.data[key] = value;
    this.length = Object.keys(this.data).length;
  }

  removeItem(key: string): void {
    delete this.data[key];
    this.length = Object.keys(this.data).length;
  }

  key(index: number): string | null {
    return Object.keys(this.data)[index] || null;
  }
}
