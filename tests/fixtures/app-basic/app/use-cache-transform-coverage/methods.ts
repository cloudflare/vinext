export const objectMethods = {
  async getValue() {
    "use cache";
    return "object-method";
  },
};

export class StaticMethods {
  static async getValue() {
    "use cache";
    return "static-method";
  }
}
