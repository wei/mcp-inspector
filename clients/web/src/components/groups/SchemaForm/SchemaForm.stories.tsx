import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { SchemaForm } from "./SchemaForm";

const meta: Meta<typeof SchemaForm> = {
  title: "Groups/SchemaForm",
  component: SchemaForm,
  args: {
    onChange: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof SchemaForm>;

export const StringFields: Story = {
  args: {
    schema: {
      type: "object",
      properties: {
        name: { type: "string", title: "Name" },
        description: { type: "string", title: "Description" },
      },
      required: ["name"],
    },
    values: {},
  },
};

export const NumberFields: Story = {
  args: {
    schema: {
      type: "object",
      properties: {
        age: { type: "integer", title: "Age", minimum: 0, maximum: 150 },
        price: { type: "number", title: "Price", minimum: 0 },
      },
    },
    values: {},
  },
};

export const BooleanFields: Story = {
  args: {
    schema: {
      type: "object",
      properties: {
        enabled: { type: "boolean", title: "Enabled" },
        verbose: { type: "boolean", title: "Verbose" },
      },
    },
    values: {},
  },
};

export const EnumDropdown: Story = {
  args: {
    schema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          title: "Format",
          enum: ["json", "csv", "xml"],
        },
      },
    },
    values: {},
  },
};

export const TitledEnum: Story = {
  args: {
    schema: {
      type: "object",
      properties: {
        size: {
          type: "string",
          title: "Size",
          oneOf: [
            { const: "small", title: "Small (1-10)" },
            { const: "medium", title: "Medium (11-100)" },
            { const: "large", title: "Large (100+)" },
          ],
        },
      },
    },
    values: {},
  },
};

export const MixedTypes: Story = {
  args: {
    schema: {
      type: "object",
      properties: {
        name: { type: "string", title: "Name" },
        count: { type: "number", title: "Count" },
        active: { type: "boolean", title: "Active" },
        color: {
          type: "string",
          title: "Color",
          enum: ["red", "green", "blue"],
        },
      },
    },
    values: {},
  },
};

export const WithDefaults: Story = {
  args: {
    schema: {
      type: "object",
      properties: {
        name: { type: "string", title: "Name", default: "John Doe" },
        count: { type: "number", title: "Count", default: 42 },
        active: { type: "boolean", title: "Active", default: true },
        format: {
          type: "string",
          title: "Format",
          enum: ["json", "csv", "xml"],
          default: "json",
        },
      },
    },
    values: {},
  },
};

export const WithDescriptions: Story = {
  args: {
    schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          title: "Name",
          description: "Enter your full name as it appears on your ID",
        },
        email: {
          type: "string",
          title: "Email",
          description: "A valid email address for notifications",
        },
        age: {
          type: "integer",
          title: "Age",
          description: "Your age in years",
          minimum: 0,
          maximum: 150,
        },
      },
    },
    values: {},
  },
};

export const Disabled: Story = {
  args: {
    schema: {
      type: "object",
      properties: {
        name: { type: "string", title: "Name" },
        count: { type: "number", title: "Count" },
        active: { type: "boolean", title: "Active" },
        color: {
          type: "string",
          title: "Color",
          enum: ["red", "green", "blue"],
        },
      },
    },
    values: {
      name: "Example",
      count: 10,
      active: true,
      color: "green",
    },
    disabled: true,
  },
};

/**
 * Arguments declared as a composition at the root of the schema (#2123): a
 * picker chooses the alternative, and its fields render beneath. Before this,
 * such a schema produced a form with no controls at all.
 */
export const RootUnion: Story = {
  args: {
    schema: {
      type: "object",
      properties: {
        message: { type: "string", title: "Message" },
      },
      required: ["message"],
      anyOf: [
        {
          type: "object",
          title: "By email",
          properties: {
            kind: { type: "string", const: "email" },
            address: { type: "string", title: "Address" },
          },
          required: ["kind", "address"],
        },
        {
          type: "object",
          title: "By SMS",
          properties: {
            kind: { type: "string", const: "sms" },
            phone: { type: "string", title: "Phone" },
          },
          required: ["kind", "phone"],
        },
      ],
    },
    values: { kind: "email" },
  },
};
