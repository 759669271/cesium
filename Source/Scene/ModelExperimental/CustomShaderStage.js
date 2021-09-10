import combine from "../../Core/combine.js";
import defined from "../../Core/defined.js";
import oneTimeWarning from "../../Core/oneTimeWarning.js";
import ShaderDestination from "../../Renderer/ShaderDestination.js";
import Pass from "../../Renderer/Pass.js";
import CustomShaderStageVS from "../../Shaders/ModelExperimental/CustomShaderStageVS.js";
import CustomShaderStageFS from "../../Shaders/ModelExperimental/CustomShaderStageFS.js";
import VertexAttributeSemantic from "../VertexAttributeSemantic.js";
import AttributeType from "../AttributeType.js";
import AlphaMode from "../AlphaMode.js";
import CustomShaderMode from "./CustomShaderMode.js";

/**
 * The custom shader pipeline stage takes GLSL callbacks from the
 * {@link CustomShader} and inserts them into the overall shader code for the
 * {@link ModelExperimental}. The input to the callback is a struct with many
 * properties that depend on the attributes of the primitive. This shader code
 * is automatically generated by this stage.
 *
 * @namespace CustomShaderStage
 *
 * @private
 */
var CustomShaderStage = {};
CustomShaderStage.name = "CustomShaderStage"; // Helps with debugging

/**
 * Process a primitive. This modifies the following parts of the render
 * resources:
 * <ul>
 *   <li>Modifies the shader to include the custom shader code to the vertex and fragment shaders</li>
 *   <li>Modifies the shader to include automatically-generated structs that serve as input to the custom shader callbacks </li>
 *   <li>Modifies the shader to include any additional user-defined uniforms</li>
 *   <li>Modifies the shader to include any additional user-defined varyings</li>
 *   <li>Adds any user-defined uniforms to the uniform map</li>
 *   <li>If the user specified a lighting model, the settings are overridden in the render resources</li>
 * </ul>
 * <p>
 * This pipeline stage is designed to fail gracefully where possible. If the
 * primitive does not have the right attributes to satisfy the shader code,
 * defaults will be inferred (when reasonable to do so). If not, the custom
 * shader will be disabled.
 * <p>
 *
 * @param {PrimitiveRenderResources} renderResources The render resources for the primitive
 * @param {ModelComponents.Primitive} primitive The primitive to be rendered
 * @param {FrameState} frameState The frame state.
 * @private
 */
CustomShaderStage.process = function (renderResources, primitive, frameState) {
  var shaderBuilder = renderResources.shaderBuilder;
  var customShader = renderResources.model.customShader;

  // Generate lines of code for the shader, but don't add them to the shader
  // yet.
  var generatedCode = generateShaderLines(customShader, primitive);

  // In some corner cases, the primitive may not be compatible with the
  // shader. In this case, skip the custom shader.
  if (!generatedCode.customShaderEnabled) {
    return;
  }
  addLinesToShader(shaderBuilder, customShader, generatedCode);

  // the input to the fragment shader may include a low-precision ECEF position
  if (generatedCode.shouldComputePositionWC) {
    shaderBuilder.addDefine(
      "COMPUTE_POSITION_WC",
      undefined,
      ShaderDestination.VERTEX
    );
  }

  if (defined(customShader.vertexShaderText)) {
    shaderBuilder.addDefine(
      "HAS_CUSTOM_VERTEX_SHADER",
      undefined,
      ShaderDestination.VERTEX
    );
  }

  if (defined(customShader.fragmentShaderText)) {
    shaderBuilder.addDefine(
      "HAS_CUSTOM_FRAGMENT_SHADER",
      undefined,
      ShaderDestination.FRAGMENT
    );

    // add defines like CUSTOM_SHADER_MODIFY_MATERIAL
    var shaderModeDefine = CustomShaderMode.getDefineName(customShader.mode);
    shaderBuilder.addDefine(
      shaderModeDefine,
      undefined,
      ShaderDestination.FRAGMENT
    );
  }

  var uniforms = customShader.uniforms;
  for (var uniformName in uniforms) {
    if (uniforms.hasOwnProperty(uniformName)) {
      var uniform = uniforms[uniformName];
      shaderBuilder.addUniform(uniform.type, uniformName);
    }
  }

  var varyings = customShader.varyings;
  for (var varyingName in varyings) {
    if (varyings.hasOwnProperty(varyingName)) {
      var varyingType = varyings[varyingName];
      shaderBuilder.addVarying(varyingType, varyingName);
    }
  }

  // if present, the lighting model overrides the material's lighting model.
  if (defined(customShader.lightingModel)) {
    renderResources.lightingOptions.lightingModel = customShader.lightingModel;
  }

  var alphaOptions = renderResources.alphaOptions;
  if (customShader.isTranslucent) {
    alphaOptions.pass = Pass.TRANSLUCENT;
    alphaOptions.alphaMode = AlphaMode.BLEND;
  } else {
    // Use the default pass (either OPAQUE or 3D_TILES), regardless of whether
    // the material pipeline stage used translucent. The default is configured
    // in AlphaPipelineStage
    alphaOptions.pass = undefined;
    alphaOptions.alphaMode = AlphaMode.OPAQUE;
  }

  renderResources.uniformMap = combine(
    renderResources.uniformMap,
    customShader.uniformMap
  );
};

function getAttributeNames(attributes) {
  var names = {};
  for (var i = 0; i < attributes.length; i++) {
    var attribute = attributes[i];
    var semantic = attribute.semantic;
    var setIndex = attribute.setIndex;

    var variableName;
    if (defined(semantic)) {
      variableName = VertexAttributeSemantic.getVariableName(
        semantic,
        setIndex
      );
    } else {
      // Handle user defined vertex attributes. They must begin with an underscore
      // For example, "_TEMPERATURE" will be converted to "temperature".
      variableName = attribute.name.substring(1).toLowerCase();
    }

    names[variableName] = attribute;
  }
  return names;
}

function generateAttributeField(name, attribute) {
  var attributeType = attribute.type;
  var glslType = AttributeType.getGlslType(attributeType);

  // Fields for the Attribute struct. for example:
  // ["vec3", "normal"];
  return [glslType, name];
}

// GLSL types of standard attribute types when uniquely defined
var attributeTypeLUT = {
  positionMC: "vec3",
  normal: "vec3",
  tangent: "vec4",
  texCoord: "vec2",
  joints: "ivec4",
  weights: "vec4",
};

// Corresponding attribute values
var attributeDefaultValueLUT = {
  positionMC: "vec3(0.0)",
  normal: "vec3(0.0, 0.0, 1.0)",
  tangent: "vec4(1.0, 0.0, 0.0, 1.0)",
  texCoord: "vec2(0.0)",
  joints: "ivec4(0)",
  weights: "vec4(0.0)",
};

function inferAttributeDefaults(attributeName) {
  // remove trailing set indices. E.g. "texCoord_0" -> "texCoord"
  var trimmed = attributeName.replace(/_[0-9]+$/, "");
  var glslType = attributeTypeLUT[trimmed];
  var value = attributeDefaultValueLUT[trimmed];

  // Return undefined for other cases that cannot be easily inferred:
  // - COLOR_x is either a vec3 or vec4
  // - _CUSTOM_ATTRIBUTE has an unknown type.
  if (!defined(glslType)) {
    return undefined;
  }

  return {
    attributeField: [glslType, attributeName],
    value: value,
  };
}

function generateVertexShaderLines(customShader, namedAttributes, vertexLines) {
  var categories = partitionAttributes(
    namedAttributes,
    customShader.usedVariablesVertex.attributeSet
  );
  var addToShader = categories.addToShader;
  var needsDefault = categories.missingAttributes;

  var variableName;
  var vertexInitialization;
  var attributeFields = [];
  var initializationLines = [];
  for (variableName in addToShader) {
    if (addToShader.hasOwnProperty(variableName)) {
      var attribute = addToShader[variableName];
      var attributeField = generateAttributeField(variableName, attribute);
      attributeFields.push(attributeField);

      // Initializing attribute structs are just a matter of copying the
      // attribute or varying: E.g.:
      // "    vsInput.attributes.position = a_position;"
      vertexInitialization =
        "vsInput.attributes." +
        variableName +
        " = attributes." +
        variableName +
        ";";
      initializationLines.push(vertexInitialization);
    }
  }

  for (var i = 0; i < needsDefault.length; i++) {
    variableName = needsDefault[i];
    var attributeDefaults = inferAttributeDefaults(variableName);
    if (!defined(attributeDefaults)) {
      CustomShaderStage._oneTimeWarning(
        "CustomShaderStage.incompatiblePrimitiveVS",
        "Primitive is missing attribute " +
          variableName +
          ", disabling custom vertex shader"
      );
      // This primitive isn't compatible with the shader. Return early
      // to skip the vertex shader
      return;
    }

    attributeFields.push(attributeDefaults.attributeField);
    vertexInitialization =
      "vsInput.attributes." +
      variableName +
      " = " +
      attributeDefaults.value +
      ";";
    initializationLines.push(vertexInitialization);
  }

  vertexLines.enabled = true;
  vertexLines.attributeFields = attributeFields;
  vertexLines.initializationLines = initializationLines;
}

function generatePositionBuiltins(customShader) {
  var fragmentInputFields = [];
  var initializationLines = [];
  var usedVariables = customShader.usedVariablesFragment.positionSet;

  // Model space position is the same position as in the glTF accessor.
  if (usedVariables.hasOwnProperty("positionMC")) {
    fragmentInputFields.push(["vec3", "positionMC"]);
    initializationLines.push("fsInput.positionMC = attributes.positionMC;");
  }

  // World coordinates in ECEF coordinates. Note that this is
  // low precision (32-bit floats) on the GPU.
  if (usedVariables.hasOwnProperty("positionWC")) {
    fragmentInputFields.push(["vec3", "positionWC"]);
    initializationLines.push("fsInput.positionWC = attributes.positionWC;");
  }

  // position in eye coordinates
  if (usedVariables.hasOwnProperty("positionEC")) {
    fragmentInputFields.push(["vec3", "positionEC"]);
    initializationLines.push("fsInput.positionEC = attributes.positionEC;");
  }

  return {
    fragmentInputFields: fragmentInputFields,
    initializationLines: initializationLines,
  };
}

function generateFragmentShaderLines(
  customShader,
  namedAttributes,
  fragmentLines
) {
  var categories = partitionAttributes(
    namedAttributes,
    customShader.usedVariablesFragment.attributeSet
  );
  var addToShader = categories.addToShader;
  var needsDefault = categories.missingAttributes;

  var variableName;
  var fragmentInitialization;
  var attributeFields = [];
  var initializationLines = [];
  for (variableName in addToShader) {
    if (addToShader.hasOwnProperty(variableName)) {
      var attribute = addToShader[variableName];
      var attributeField = generateAttributeField(variableName, attribute);
      attributeFields.push(attributeField);

      // Initializing attribute structs are just a matter of copying the
      // value from the processed attributes
      // "    fsInput.attributes.positionMC = attributes.positionMC;"
      fragmentInitialization =
        "fsInput.attributes." +
        variableName +
        " = attributes." +
        variableName +
        ";";
      initializationLines.push(fragmentInitialization);
    }
  }

  for (var i = 0; i < needsDefault.length; i++) {
    variableName = needsDefault[i];
    var attributeDefaults = inferAttributeDefaults(variableName);
    if (!defined(attributeDefaults)) {
      CustomShaderStage._oneTimeWarning(
        "CustomShaderStage.incompatiblePrimitiveFS",
        "Primitive is missing attribute " +
          variableName +
          ", disabling custom fragment shader."
      );

      // This primitive isn't compatible with the shader. Return early
      // so the fragment shader is skipped
      return;
    }

    attributeFields.push(attributeDefaults.attributeField);
    fragmentInitialization =
      "fsInput.attributes." +
      variableName +
      " = " +
      attributeDefaults.value +
      ";";
    initializationLines.push(fragmentInitialization);
  }

  // Built-ins for positions in various coordinate systems.
  var positionBuiltins = generatePositionBuiltins(customShader);

  fragmentLines.enabled = true;
  fragmentLines.attributeFields = attributeFields;
  fragmentLines.fragmentInputFields = positionBuiltins.fragmentInputFields;
  fragmentLines.initializationLines = positionBuiltins.initializationLines.concat(
    initializationLines
  );
}

function partitionAttributes(primitiveAttributes, shaderAttributeSet) {
  // shaderAttributes = set of all attributes used in the shader
  // primitiveAttributes = set of all the primitive's attributes
  // partition into three categories:
  // - addToShader = shaderAttributes intersect primitiveAttributes
  // - missingAttributes = shaderAttributes - primitiveAttributes
  // - unneededAttributes = primitive-attributes - shaderAttributes
  //
  // addToShader are attributes that should be added to the shader.
  // missingAttributes are attributes for which we need to provide a default value
  // unneededAttributes are other attributes that can be skipped.

  var attributeName;
  var addToShader = {};
  for (attributeName in primitiveAttributes) {
    if (primitiveAttributes.hasOwnProperty(attributeName)) {
      var attribute = primitiveAttributes[attributeName];

      if (shaderAttributeSet.hasOwnProperty(attributeName)) {
        addToShader[attributeName] = attribute;
      }
    }
  }

  var missingAttributes = [];
  for (attributeName in shaderAttributeSet) {
    if (!primitiveAttributes.hasOwnProperty(attributeName)) {
      missingAttributes.push(attributeName);
    }
  }

  return {
    addToShader: addToShader,
    missingAttributes: missingAttributes,
  };
}

function generateShaderLines(customShader, primitive) {
  // Assume shader code is disabled unless proven otherwise
  var vertexLines = {
    enabled: false,
  };
  var fragmentLines = {
    enabled: false,
  };

  // Attempt to generate vertex and fragment shader lines before adding any
  // code to the shader.
  var namedAttributes = getAttributeNames(primitive.attributes);
  if (defined(customShader.vertexShaderText)) {
    generateVertexShaderLines(customShader, namedAttributes, vertexLines);
  }

  if (defined(customShader.fragmentShaderText)) {
    generateFragmentShaderLines(customShader, namedAttributes, fragmentLines);
  }

  // positionWC must be computed in the vertex shader
  // for use in the fragmentShader. However, this can be skipped if:
  // - positionWC isn't used in the fragment shader
  // - or the fragment shader is disabled
  var shouldComputePositionWC =
    "positionWC" in customShader.usedVariablesFragment.positionSet &&
    fragmentLines.enabled;

  // Return any generated shader code along with some flags to indicate which
  // defines should be added.
  return {
    vertexLines: vertexLines,
    fragmentLines: fragmentLines,
    vertexLinesEnabled: vertexLines.enabled,
    fragmentLinesEnabled: fragmentLines.enabled,
    customShaderEnabled: vertexLines.enabled || fragmentLines.enabled,
    shouldComputePositionWC: shouldComputePositionWC,
  };
}

function addVertexLinesToShader(shaderBuilder, vertexLines) {
  // Vertex Lines ---------------------------------------------------------

  var i;
  var structId = "AttributesVS";
  shaderBuilder.addStruct(structId, "Attributes", ShaderDestination.VERTEX);

  var attributeFields = vertexLines.attributeFields;
  for (i = 0; i < attributeFields.length; i++) {
    var field = attributeFields[i];
    var glslType = field[0];
    var variableName = field[1];
    shaderBuilder.addStructField(structId, glslType, variableName);
  }

  // This could be hard-coded, but the symmetry with other structs makes unit
  // tests more convenient
  structId = "VertexInput";
  shaderBuilder.addStruct(structId, "VertexInput", ShaderDestination.VERTEX);
  shaderBuilder.addStructField(structId, "Attributes", "attributes");

  var functionId = "initializeInputStructVS";
  var functionSignature =
    "void initializeInputStruct(out VertexInput vsInput, ProcessedAttributes attributes)";
  shaderBuilder.addFunction(
    functionId,
    functionSignature,
    ShaderDestination.VERTEX
  );

  var initializationLines = vertexLines.initializationLines;
  for (i = 0; i < initializationLines.length; i++) {
    var line = initializationLines[i];
    shaderBuilder.addFunctionLine(functionId, line);
  }
}

function addFragmentLinesToShader(shaderBuilder, fragmentLines) {
  var i;
  var structId = "AttributesFS";
  shaderBuilder.addStruct(structId, "Attributes", ShaderDestination.FRAGMENT);

  var field;
  var glslType;
  var variableName;
  var attributeFields = fragmentLines.attributeFields;
  for (i = 0; i < attributeFields.length; i++) {
    field = attributeFields[i];
    glslType = field[0];
    variableName = field[1];
    shaderBuilder.addStructField(structId, glslType, variableName);
  }

  structId = "FragmentInput";
  shaderBuilder.addStruct(
    structId,
    "FragmentInput",
    ShaderDestination.FRAGMENT
  );
  shaderBuilder.addStructField(structId, "Attributes", "attributes");

  var fragmentInputFields = fragmentLines.fragmentInputFields;
  for (i = 0; i < fragmentInputFields.length; i++) {
    field = fragmentInputFields[i];
    glslType = field[0];
    variableName = field[1];
    shaderBuilder.addStructField(structId, glslType, variableName);
  }

  var functionId = "initializeInputStructFS";
  var functionSignature =
    "void initializeInputStruct(out FragmentInput fsInput, ProcessedAttributes attributes)";
  shaderBuilder.addFunction(
    functionId,
    functionSignature,
    ShaderDestination.FRAGMENT
  );

  var initializationLines = fragmentLines.initializationLines;
  for (i = 0; i < initializationLines.length; i++) {
    var line = initializationLines[i];
    shaderBuilder.addFunctionLine(functionId, line);
  }
}

function addLinesToShader(shaderBuilder, customShader, generatedCode) {
  var vertexLines = generatedCode.vertexLines;
  if (vertexLines.enabled) {
    addVertexLinesToShader(shaderBuilder, vertexLines);

    shaderBuilder.addVertexLines([
      "#line 0",
      customShader.vertexShaderText,
      CustomShaderStageVS,
    ]);
  }

  var fragmentLines = generatedCode.fragmentLines;
  if (fragmentLines.enabled) {
    addFragmentLinesToShader(shaderBuilder, fragmentLines);

    shaderBuilder.addFragmentLines([
      "#line 0",
      customShader.fragmentShaderText,
      CustomShaderStageFS,
    ]);
  }
}

// exposed for testing.
CustomShaderStage._oneTimeWarning = oneTimeWarning;

export default CustomShaderStage;
